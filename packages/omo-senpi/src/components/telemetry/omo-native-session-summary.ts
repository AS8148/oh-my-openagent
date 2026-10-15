import { randomUUID } from "node:crypto"
import type { TelemetryDiagnosticInput } from "@oh-my-opencode/telemetry-core"

import type { TelemetrySessionRole } from "./session-role"
import { CORRUPT, removeFile } from "./session-summary-files"
import { createSummaryPublisher, type PublishSummary } from "./session-summary-publisher"
import { createSummaryRecovery } from "./session-summary-recovery"
import { isSessionSampled } from "./session-summary-sampling"
import type { RecordConsent, SummaryStorage, WindowRecord } from "./session-summary-storage"
import { addTurn, openWindow, type EndedBy, type SummaryTurn, type SummaryWindow } from "./session-summary-window"

export type { SummaryTurn } from "./session-summary-window"
export type { SummaryPublication } from "./session-summary-publisher"
export { RAW_TURN_SAMPLE_RATE, isSessionSampled } from "./session-summary-sampling"

export const CHECKPOINT_MAX_TURNS = 50
export const CHECKPOINT_MAX_WINDOW_MS = 30 * 60_000
export const HEARTBEAT_INTERVAL_MS = 60_000

export type ScheduleHeartbeat = (tick: () => void, intervalMs: number) => () => void

export type SessionSummaryOptions = {
  /** The originating session's consent, stamped on every record; anything but `enabled` records nothing. */
  readonly consent: RecordConsent
  readonly storage: SummaryStorage
  readonly publish: PublishSummary
  readonly sessionRole: TelemetrySessionRole
  /** Read when a window opens; the component resolves config, env and sink lazily behind it. */
  readonly sampleRate: () => number
  readonly now?: () => number
  readonly diagnostics?: (input: TelemetryDiagnosticInput) => void
  readonly scheduleHeartbeat?: ScheduleHeartbeat
  /** Events the transport knows it dropped since the last call (todo 21 wires the OTLP sender's counter). */
  readonly droppedEvents?: () => number
}

export type SessionSummaryRecorder = {
  readonly sampleRate: number
  readonly isRawTurnSampled: (sessionHash: string) => boolean
  /** Re-sends unacknowledged events (this process's and dead ones') and recovers abandoned windows. */
  readonly recover: () => Promise<void>
  /** Resolves when every publication this call started has been acknowledged or given up. */
  readonly recordTurn: (sessionHash: string, turn: SummaryTurn) => Promise<void>
  /** `reload` keeps the session's sequence so the next registration continues it. */
  readonly finish: (sessionHash: string, reason: string | undefined) => Promise<void>
}

type Live = {
  key: string
  seq: number
  sampleRate: number
  windowId: string | null
  window: SummaryWindow | null
}

export function createSessionSummaryRecorder(options: SessionSummaryOptions): SessionSummaryRecorder {
  const { storage } = options
  const now = options.now ?? storage.now
  const publisher = createSummaryPublisher({
    storage,
    publish: options.publish,
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
    ...(options.droppedEvents === undefined ? {} : { transportDropped: options.droppedEvents }),
  })
  const recovery = createSummaryRecovery({
    storage,
    publisher,
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
  })
  const live = new Map<string, Live>()
  let swept = false
  let stopHeartbeat: (() => void) | undefined

  const report = (error: unknown): void => {
    options.diagnostics?.({
      event: "telemetry_activity_state_write_failed",
      source: "omo-native-session-summary",
      error: error instanceof Error ? error : new Error(String(error)),
      errorKind: error instanceof Error ? "error" : "non_error",
    })
  }

  const recordOf = (sessionHash: string, entry: Live): WindowRecord => ({
    consent: options.consent,
    sessionHash,
    sessionRole: options.sessionRole,
    owner: storage.owner,
    heartbeatAt: now(),
    seq: entry.seq,
    sampleRate: entry.sampleRate,
    windowId: entry.windowId,
    window: entry.window,
  })

  const persist = (sessionHash: string, entry: Live): void => {
    try {
      storage.writeWindow(entry.key, recordOf(sessionHash, entry))
    } catch (error) {
      report(error)
    }
  }

  const heartbeat = (): void => {
    for (const [sessionHash, entry] of live) if (entry.window !== null) persist(sessionHash, entry)
    runSweep()
  }

  const runSweep = (): void => {
    try {
      recovery.sweep()
    } catch (error) {
      report(error)
    }
  }

  const sweepOnce = (): void => {
    if (swept) return
    swept = true
    runSweep()
  }

  const ensureHeartbeat = (): void => {
    if (stopHeartbeat !== undefined) return
    stopHeartbeat = (options.scheduleHeartbeat ?? scheduleUnrefInterval)(heartbeat, HEARTBEAT_INTERVAL_MS)
  }

  const liveFor = (sessionHash: string): Live => {
    const cached = live.get(sessionHash)
    if (cached !== undefined) return cached
    const entry = adopt(sessionHash)
    live.set(sessionHash, entry)
    return entry
  }

  // A session's file is continued by whoever records its next turn: this process's own file, or the file
  // of a dead owner (claimed first, so two resuming processes never both continue it). A file a LIVE
  // process still owns is left alone; this process keeps its own copy beside it.
  const adopt = (sessionHash: string): Live => {
    const key = storage.windowKey(sessionHash)
    const fresh = (seq: number, entryKey = key): Live => ({ key: entryKey, seq, sampleRate: options.sampleRate(), windowId: null, window: null })
    const stored = storage.readWindow(key)
    if (stored === undefined || stored === CORRUPT) return fresh(0)
    if (stored.consent !== "enabled") {
      storage.removeWindow(key)
      return fresh(0)
    }
    if (stored.owner.pid === storage.owner.pid && stored.owner.bootId === storage.owner.bootId) {
      return { key, seq: stored.seq, sampleRate: stored.sampleRate, windowId: stored.windowId, window: stored.window }
    }
    if (storage.isOwnerAlive(stored.owner)) return fresh(stored.seq, storage.windowKey(sessionHash, true))
    const claimed = storage.claimWindow(key)
    // Another process won the claim and now continues the shared file: this one keeps its own copy beside it.
    if (claimed === undefined) return fresh(stored.seq, storage.windowKey(sessionHash, true))
    const record = claimed.record
    if (record === undefined || record === CORRUPT || record.consent !== "enabled") {
      removeFile(claimed.claimPath)
      return fresh(record === undefined || record === CORRUPT ? stored.seq : 0)
    }
    const published = record.windowId !== null && storage.hasPending(record.windowId)
    const entry: Live = published || record.window === null
      ? fresh(published ? record.seq + 1 : record.seq)
      : { key, seq: record.seq, sampleRate: record.sampleRate, windowId: record.windowId, window: record.window }
    persist(sessionHash, entry)
    removeFile(claimed.claimPath)
    return entry
  }

  const close = (sessionHash: string, entry: Live, endedBy: EndedBy, keepFile: boolean): void => {
    const window = entry.window ?? openWindow(now(), 0)
    const windowId = entry.windowId ?? randomUUID()
    const seq = entry.seq
    void publisher.publishWindow({
      consent: options.consent, sessionHash, sessionRole: options.sessionRole, sampleRate: entry.sampleRate, seq, windowId, window, endedBy,
    }, () => {
      entry.seq = seq + 1
      entry.window = null
      entry.windowId = null
      if (keepFile) persist(sessionHash, entry)
      else storage.removeWindow(entry.key)
    })
  }

  return {
    get sampleRate() {
      return options.sampleRate()
    },
    isRawTurnSampled: (sessionHash) => isSessionSampled(sessionHash, options.sampleRate()),
    async recover() {
      if (options.consent !== "enabled") return
      swept = true
      runSweep()
      await publisher.settled()
    },
    async recordTurn(sessionHash, turn) {
      if (options.consent !== "enabled") return
      sweepOnce()
      ensureHeartbeat()
      const entry = liveFor(sessionHash)
      const at = now()
      if (entry.window === null) {
        entry.window = openWindow(at, turn.turnIndex)
        entry.windowId = randomUUID()
        entry.sampleRate = options.sampleRate()
      }
      addTurn(entry.window, turn, at)
      if (entry.window.totals.length >= CHECKPOINT_MAX_TURNS || at - entry.window.startedAt >= CHECKPOINT_MAX_WINDOW_MS) {
        close(sessionHash, entry, "checkpoint", true)
      } else {
        persist(sessionHash, entry)
      }
      await publisher.settled()
    },
    async finish(sessionHash, reason) {
      if (options.consent !== "enabled") return
      sweepOnce()
      const entry = liveFor(sessionHash)
      live.delete(sessionHash)
      if (live.size === 0) {
        stopHeartbeat?.()
        stopHeartbeat = undefined
      }
      const ownCopy = entry.key !== storage.windowKey(sessionHash)
      if (reason === "reload") {
        if (entry.window !== null) close(sessionHash, entry, "reload", !ownCopy)
        else if (entry.seq > 0 && !ownCopy) persist(sessionHash, entry)
      } else if (entry.window !== null || entry.seq > 0) {
        close(sessionHash, entry, "shutdown", !ownCopy)
      } else {
        storage.removeWindow(entry.key)
      }
      await publisher.settled()
    },
  }
}

function scheduleUnrefInterval(tick: () => void, intervalMs: number): () => void {
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
