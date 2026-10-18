import type { SessionDigest } from "./types"

export interface SessionDigestStore {
  put(scanId: string, digest: SessionDigest): Promise<void>
  list(scanId: string): Promise<ReadonlyArray<SessionDigest>>
  drop(scanId: string): Promise<void>
}

export function createSessionDigestStore(_options: { readonly stateDir: string }): SessionDigestStore {
  throw new Error("session-history: not implemented")
}
