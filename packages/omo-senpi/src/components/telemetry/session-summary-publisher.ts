import type { EventTelemetryProperties, TelemetryDiagnosticInput } from "@oh-my-opencode/telemetry-core"

import type { TelemetrySessionRole } from "./session-role"
import type { PendingRecord, SummaryStorage } from "./session-summary-storage"
import { summaryProperties, type EndedBy, type SummaryWindow } from "./session-summary-window"
import { isSessionSampled } from "./session-summary-sampling"

/** `timestamp` is the window's close time (the pending record's createdAt), the same on every re-send. */
export type SummaryPublication = { readonly uuid: string; readonly properties: EventTelemetryProperties; readonly timestamp: number }

/** Resolves true only when the transport acknowledged the event (collector 200, PostHog flush resolved). */
export type PublishSummary = (publication: SummaryPublication) => Promise<boolean>

export type ClosedWindow = {
  readonly sessionHash: string
  readonly sessionRole: TelemetrySessionRole
  readonly sampleRate: number
  readonly seq: number
  readonly windowId: string
  readonly window: SummaryWindow
  readonly endedBy: EndedBy
}

export type SummaryPublisher = {
  /**
   * The publication protocol, in this order: (1) the exact event lands in `pending/<window_id>.json`,
   * (2) `advanceSeq` persists the next sequence, (3) the event is published, (4) the pending file is deleted
   * only on acknowledgment. A crash before (1) leaves the window for recovery; a crash after (1) leaves a
   * pending file that is re-sent with the same uuid, so the window is never published under two ids.
   */
  readonly publishWindow: (closed: ClosedWindow, advanceSeq: () => void) => Promise<void>
  readonly deliver: (record: PendingRecord) => Promise<void>
  readonly isInFlight: (uuid: string) => boolean
  readonly countDropped: (count: number) => void
  /** Resolves once every delivery started so far has been acknowledged or given up. */
  readonly settled: () => Promise<void>
}

export function createSummaryPublisher(input: {
  readonly storage: SummaryStorage
  readonly publish: PublishSummary
  readonly diagnostics?: (input: TelemetryDiagnosticInput) => void
  readonly transportDropped?: () => number
}): SummaryPublisher {
  const inFlight = new Set<string>()
  const running = new Set<Promise<void>>()
  let dropped = 0

  const report = (event: TelemetryDiagnosticInput["event"], error: unknown): void => {
    input.diagnostics?.({
      event,
      source: "omo-native-session-summary",
      error: error instanceof Error ? error : new Error(String(error)),
      errorKind: error instanceof Error ? "error" : "non_error",
    })
  }

  const takeDropped = (): number => {
    const total = dropped + (input.transportDropped?.() ?? 0)
    dropped = 0
    return total
  }

  const send = async (record: PendingRecord): Promise<void> => {
    try {
      if (await input.publish({ uuid: record.uuid, properties: record.properties, timestamp: record.createdAt })) input.storage.removePending(record.uuid)
    } catch (error) {
      report("telemetry_capture_failed", error)
    } finally {
      inFlight.delete(record.uuid)
    }
  }

  const deliver = (record: PendingRecord): Promise<void> => {
    if (inFlight.has(record.uuid)) return Promise.resolve()
    inFlight.add(record.uuid)
    const delivery = send(record)
    running.add(delivery)
    void delivery.finally(() => running.delete(delivery))
    return delivery
  }

  return {
    deliver,
    isInFlight: (uuid) => inFlight.has(uuid),
    settled: async () => {
      await Promise.all([...running])
    },
    countDropped(count) {
      dropped += count
    },
    async publishWindow(closed, advanceSeq) {
      const record: PendingRecord = {
        uuid: closed.windowId,
        sessionHash: closed.sessionHash,
        owner: input.storage.owner,
        createdAt: input.storage.now(),
        properties: summaryProperties(closed.sessionHash, closed.window, {
          endedBy: closed.endedBy,
          seq: closed.seq,
          sampleRate: closed.sampleRate,
          sampled: isSessionSampled(closed.sessionHash, closed.sampleRate),
          sessionRole: closed.sessionRole,
          droppedEvents: takeDropped(),
        }),
      }
      try {
        input.storage.writePending(record)
      } catch (error) {
        report("telemetry_activity_state_write_failed", error)
      }
      try {
        advanceSeq()
      } catch (error) {
        report("telemetry_activity_state_write_failed", error)
      }
      await deliver(record)
    },
  }
}
