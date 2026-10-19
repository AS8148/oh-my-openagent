import { describe, expect, test } from "bun:test"
import type { CreateAgentSessionOptions } from "@code-yeongyu/senpi"
import { proposalId, type FactsQueueEntry, type TranscriptEntry } from "@oh-my-opencode/memory-core"
import type { ChildSessionListener, CreateChildSession } from "@oh-my-opencode/senpi-task"
import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { launchFactsInProcess } from "./facts-in-process-launch"
import { FACTS_RECORD_TOOL_NAME } from "./facts-record-tool"
import { fixture, registrySnapshot, runnerOptions } from "./facts-runner.test-support"
import { writeRunJsonAtomic } from "./worker/run-artifacts"

// #10488 / #10498 end to end through the real facts path: two real settles go through FactsQueue.enqueue, only the
// SECOND queue entry (the one holding the user's reply) reaches the extractor, as it does once the first was consumed,
// and the facts child records the decision through the real record_fact tool. Only the model's turn is scripted.

const PROPOSAL = "Shall I delete plugin X?"
let line = 0
const row = (kind: TranscriptEntry["kind"], text: string): TranscriptEntry => {
  line += 1
  return { kind, text, captured_at: "2026-10-19T00:00:00.000Z", source_line_id: `l${line}`, source_message_id: `m${line}` } as TranscriptEntry
}

async function recordedReceipt(after: readonly TranscriptEntry[], quote: string): Promise<unknown> {
  const { root, identity, queue } = await fixture()
  const conversation = "conv-consent"
  const firstSettle = [row("user", "Clean up the plugins."), row("assistant", PROPOSAL)]
  const secondSettle = [...firstSettle, ...after, row("assistant", "Done.")]
  await queue.enqueue({ identity: identity.id, sessionId: conversation, conversationId: conversation, entries: firstSettle })
  await queue.enqueue({ identity: identity.id, sessionId: conversation, conversationId: conversation, entries: secondSettle })
  const pending = (await queue.listPending()).filter((entry: FactsQueueEntry) => entry.conversationId === conversation)
  expect(pending).toHaveLength(2)
  const replyEntry = pending[1]
  if (replyEntry === undefined) throw new Error("no reply entry")

  const runId = "facts-consent"
  const runDir = join(root, runId)
  await mkdir(runDir)
  await writeRunJsonAtomic(join(runDir, "ledger.json"), { version: 1, runId, kind: "facts" })
  const createSession: CreateChildSession = async (options: CreateAgentSessionOptions) => {
    const listeners = new Set<ChildSessionListener>()
    const recordFact = (options.customTools ?? []).find((tool) => tool.name === FACTS_RECORD_TOOL_NAME)
    if (recordFact === undefined) throw new Error("record_fact was not handed to the facts child")
    return {
      sessionId: "facts-child",
      prompt: async () => {
        await Reflect.apply(recordFact.execute, recordFact, ["fact-1", { scope: "project", text: "The user approved deleting plugin X.", date: "2026-10-19", source: "user", user_quote: quote }])
        for (const listener of listeners) listener({ type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } })
      },
      steer: async () => "handled",
      followUp: async () => "handled",
      abort: async () => undefined,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      getLastAssistantText: () => undefined,
      dispose: () => undefined,
    }
  }
  const options = runnerOptions(root, identity, queue, "empty", { createRunner: undefined, createSession })
  await launchFactsInProcess({
    runId,
    runDir,
    payload: { version: 1, identity: identity.id, today: "2026-10-19", entries: [replyEntry], knownPeople: [], primaryHuman: { slug: "human", aliases: [] } },
    resolution: { kind: "resolved", category: "quick", model: "omo-mock/mock-1", fallbacks: [] },
    modelRegistry: registrySnapshot([{ id: "mock-1" }]),
    options,
    env: { HOME: root },
    configSources: [],
    batchId: "facts-consent-batch",
    queued: [],
    launchedAt: 0,
    deadlineMs: 10_000,
  })
  const [record] = (await readFile(join(runDir, "extraction.jsonl"), "utf8")).trim().split("\n").map((text) => JSON.parse(text) as { readonly receipt?: unknown })
  return record?.receipt
}

describe("facts consent end to end", () => {
  test("#given a deletion proposal #when the user replies 'yes delete it' in the next turn #then the recorded fact carries a user receipt naming that proposal", async () => {
    expect(await recordedReceipt([row("user", "yes delete it")], "yes delete it"))
      .toEqual({ source: "user", userQuote: "yes delete it", approves: proposalId(PROPOSAL) })
  }, 30_000)

  test("#given a deletion proposal #when the user replies 'maybe' #then the fact is stored as an agent suggestion and the user must confirm", async () => {
    expect(await recordedReceipt([row("user", "maybe")], "maybe")).toEqual({ source: "agent", downgraded: true })
  }, 30_000)

  test("#given a deletion proposal #when an image-only message comes before the 'yes' #then the 'yes' no longer answers the proposal", async () => {
    expect(await recordedReceipt([row("user", ""), row("user", "yes")], "yes")).toEqual({ source: "agent", downgraded: true })
  }, 30_000)
})
