import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { listNames } from "./session-summary-files"

const MAX_SEQ_PROBES = 10_000

/**
 * `summary_seq` is unique per session across every process that writes it. Before a window gets its seq, the
 * writer exclusively creates `seq/<session>/<n>`; a seq another process already took fails the create, so
 * the writer moves to the next one. Lock-free, so a crash never strands a lock.
 */
export type SeqReservations = {
  readonly reserve: (sessionKey: string, from: number) => number
  /** Forgets a session's reservations (its telemetry was opted out, so nothing of it may stay on disk). */
  readonly forget: (sessionKey: string) => void
  readonly prune: (maxAgeMs: number, now: number) => void
}

export function createSeqReservations(summaryDir: string): SeqReservations {
  const root = join(summaryDir, "seq")
  return {
    reserve(sessionKey, from) {
      const dir = join(root, sessionKey)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      for (let seq = from; seq < from + MAX_SEQ_PROBES; seq += 1) {
        if (createExclusive(join(dir, String(seq)))) return seq
      }
      throw new Error(`no free session summary seq in ${MAX_SEQ_PROBES} probes`)
    },
    forget(sessionKey) {
      rmSync(join(root, sessionKey), { recursive: true, force: true })
    },
    prune(maxAgeMs, now) {
      for (const sessionKey of listNames(root)) {
        const dir = join(root, sessionKey)
        if (now - modifiedAt(dir) > maxAgeMs) rmSync(dir, { recursive: true, force: true })
      }
    },
  }
}

function createExclusive(path: string): boolean {
  try {
    writeFileSync(path, "", { flag: "wx", mode: 0o600 })
    return true
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "EEXIST") return false
    throw error
  }
}

function modifiedAt(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return Number.POSITIVE_INFINITY
  }
}
