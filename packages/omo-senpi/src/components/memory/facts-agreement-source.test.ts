import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseAgreementRecordsJsonl } from "@oh-my-opencode/memory-core"
import { createFactsAgreementTool } from "./facts-agreement-tool"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

test("record_agreement accepts only a payload user-message source and retains it in extraction", async () => {
  // given
  const root = await mkdtemp(join(tmpdir(), "agreement-source-tool-"))
  roots.push(root)
  const extractionPath = join(root, "agreements.jsonl")
  const source = { sessionId: "fixture-session", messageId: "user-1" }
  const tool = createFactsAgreementTool({ extractionPath, knownIds: new Set(), sources: [source] })
  const record = {
    action: "new", applies: "global", text: "Use synthetic fixtures", date: "2026-09-11",
  } as const

  // when
  const foreign = await tool.execute("call-1", { ...record, source: { ...source, sessionId: "other-session" } })
  const assistant = await tool.execute("call-2", { ...record, source: { ...source, messageId: "assistant-1" } })
  const accepted = await tool.execute("call-3", { ...record, source })

  // then
  expect(foreign.isError).toBe(true)
  expect(assistant.isError).toBe(true)
  expect(accepted.isError).not.toBe(true)
  expect(parseAgreementRecordsJsonl(await readFile(extractionPath, "utf8")))
    .toEqual([{ ...record, source }])
})

test("agreement source parsing rejects empty or malformed identities", () => {
  // given
  const record = { action: "new", applies: "global", text: "Use synthetic fixtures", date: "2026-09-11" }

  // when / then
  for (const source of [null, {}, { sessionId: "", messageId: "m1" }, { sessionId: "s1", messageId: "m1", extra: true }]) {
    expect(() => parseAgreementRecordsJsonl(JSON.stringify({ ...record, source }))).toThrow()
  }
})
