import { afterEach, expect, test } from "bun:test"
import { childOpenInput, sessionClientHarness } from "./session-client.test-support"

const harness = sessionClientHarness()
afterEach(harness.release)

test("a refused confirmed close keeps the same session route available for retry", async () => {
  const host = await harness.fakeHost()
  const client = harness.hostClient(host)
  const opened = await client.open(childOpenInput("/tmp/sessions/confirmed-close.jsonl"))
  host.failReply("close_session", "host_draining")
  const refusal = await client.closeConfirmed().catch((error: unknown) => error)
  expect(refusal).toBeInstanceOf(Error)
  expect(client.sessionId).toBe(opened.sessionId)
  expect(host.sessions()).toHaveLength(1)
  host.failReply("close_session", undefined)
  await client.closeConfirmed()
  expect(host.sessions()).toHaveLength(0)
  expect(host.commands.filter(command => command.type === "open_session")).toHaveLength(1)
  expect(host.commands.filter(command => command.type === "close_session")).toHaveLength(2)
})
