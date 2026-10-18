import { resolveClaimReceipt } from "@oh-my-opencode/memory-core"

import type { MemoryIdentityContext } from "./context"
import { allUserTexts } from "./recall-session-read"

export interface MemoryToolProvenanceInput {
  readonly sessionId: string
  readonly userTurns: number
  readonly context: MemoryIdentityContext
  readonly toolCallId: unknown
  readonly input: Record<string, unknown>
  readonly entries: readonly unknown[]
}

// The whole object replaces whatever the model passed, so neither the identity keys nor the claim
// receipt can be forged from tool arguments. A `user` claim keeps its source only when its quote
// appears verbatim in this session's user messages; otherwise it is stored as an agent suggestion (#10488).
export function memoryToolProvenance(input: MemoryToolProvenanceInput): Record<string, unknown> {
  return {
    sessionId: input.sessionId,
    userTurns: input.userTurns,
    identityId: input.context.identity,
    repoPath: input.context.identityPaths.repo,
    ...(typeof input.toolCallId === "string" && input.toolCallId.length > 0 ? { toolCallId: input.toolCallId } : {}),
    claim: resolveClaimReceipt(
      { source: input.input.source, userQuote: input.input.user_quote },
      allUserTexts(input.entries),
    ),
  }
}
