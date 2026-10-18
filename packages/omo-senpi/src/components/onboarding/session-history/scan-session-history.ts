import type { SessionDigestStore } from "./digest-store"
import type { RecentSessionsQuery, ScanCounts, SessionHistoryOptions } from "./types"

export type SessionHistoryScanSource = "projects" | "sessions"

export interface SessionHistoryScanEvent {
  readonly scanId: string
  readonly kind: "source_started" | "item" | "source_done" | "source_failed"
  readonly source: SessionHistoryScanSource
  readonly item?: unknown
  readonly counts?: ScanCounts
  readonly error?: string
  readonly elapsedMs: number
}

export function scanSessionHistory(_options: SessionHistoryOptions & RecentSessionsQuery & { readonly scanId: string; readonly digestStore: SessionDigestStore }): AsyncIterable<SessionHistoryScanEvent> {
  throw new Error("session-history: not implemented")
}
