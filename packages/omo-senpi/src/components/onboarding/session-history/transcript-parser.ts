import type { AgentSessionSource, AgentSessionThread } from "./types"

export function parseAgentSessionTranscript(_input: { readonly contents: string; readonly source: AgentSessionSource; readonly fallbackSessionId: string; readonly lastActiveAtMs: number }): AgentSessionThread | null {
  throw new Error("session-history: not implemented")
}
