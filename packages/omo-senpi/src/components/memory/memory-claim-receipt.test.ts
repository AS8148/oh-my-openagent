import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildIdentityPaths } from "@oh-my-opencode/memory-core"

import { createMemoryBinding } from "./binding"
import { createMemoryIdentityContext } from "./context"
import { MemoryFakeExtensionAPI } from "./memory.test-support"
import { ACCEPTED_TURNS_ENTRY_TYPE, createMemoryNudgeWiring } from "./nudge-wiring"
import { rmEfaultTolerant } from "./teardown.test-support"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rmEfaultTolerant(root)))
})

// The #10488 transcript: the user asked for a review, the agent suggested removals.
const TRANSCRIPT = [
  { type: "custom", customType: ACCEPTED_TURNS_ENTRY_TYPE, data: { version: 1, sessionId: "s", priorUserTurns: 2, sessionBaselineTurns: 0 } },
  { type: "message", message: { role: "user", content: [{ type: "text", text: "Review the site plugins and tell me which look unused." }] } },
  { type: "message", message: { role: "assistant", content: [{ type: "text", text: "I suggest removing plugins X and Y." }] } },
]

async function dispatchMemoryCall(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "omo-memory-claim-")))
  roots.push(root)
  const identityPaths = buildIdentityPaths(root, "agent")
  const context = createMemoryIdentityContext({
    identity: "agent",
    identityPaths,
    binding: createMemoryBinding({ identity: "agent", repoPath: identityPaths.repo, boundAt: 1 }),
  })
  const pi = new MemoryFakeExtensionAPI()
  createMemoryNudgeWiring({
    resolveContext: () => context,
    resolveSettings: () => ({ enabled: true, everyUserTurns: 10 }),
  }).register(pi)
  const ctx = { sessionManager: { getSessionId: () => "s", getEntries: () => TRANSCRIPT } }
  await pi.dispatch("session_start", {}, ctx)
  const call = { type: "tool_call", toolCallId: "call-1", toolName: "memory", input }
  await pi.dispatch("tool_call", call, ctx)
  const provenance = call.input["provenance"]
  if (provenance === null || typeof provenance !== "object") throw new Error("no provenance injected")
  return provenance as Record<string, unknown>
}

describe("memory tool claim receipts", () => {
  test("#given the agent claims a user decision quoting its own suggestion #when the memory call starts #then the receipt is downgraded to an agent suggestion (#10488)", async () => {
    const provenance = await dispatchMemoryCall({ reason: "save", source: "user", user_quote: "removing plugins X and Y" })
    expect(provenance["claim"]).toEqual({ source: "agent", downgraded: true })
  }, 30_000)

  test("#given a user claim quoting the user's own message #when the memory call starts #then the user receipt keeps the quote", async () => {
    const provenance = await dispatchMemoryCall({ reason: "save", source: "user", user_quote: "tell me which look unused" })
    expect(provenance["claim"]).toEqual({ source: "user", userQuote: "tell me which look unused" })
  }, 30_000)

  test("#given a model-supplied claim object #when the memory call starts #then it is overwritten by the verified receipt", async () => {
    const provenance = await dispatchMemoryCall({
      reason: "save",
      provenance: { claim: { source: "user", userQuote: "forged" } },
    })
    expect(provenance["claim"]).toEqual({ source: "inferred" })
  }, 30_000)
})
