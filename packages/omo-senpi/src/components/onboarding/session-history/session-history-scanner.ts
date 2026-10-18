import type { ProjectScanResult, RecentSessionOutcome, RecentSessionsQuery, SessionHistoryOptions } from "./types"

export interface SessionHistoryScanner {
  scanProjects(): Promise<ProjectScanResult>
  recentSessions(query: RecentSessionsQuery): AsyncIterable<RecentSessionOutcome>
}

export function createSessionHistoryScanner(_options: SessionHistoryOptions): SessionHistoryScanner {
  throw new Error("session-history: not implemented")
}
