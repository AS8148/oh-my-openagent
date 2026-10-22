import { afterEach, describe, expect, test } from "bun:test"

import { isHostSessionHandle } from "./rpc-host"
import { childSpec, hostRunnerHarness } from "./rpc-host.test-support"

const harness = hostRunnerHarness()
afterEach(() => harness.release())

// The manager records child_session_id from `handle.sessionId` right after spawn (#recordSpawnFacts).
// A hosted handle used to learn its durable id only on a later heartbeat, so that write never
// happened and a grandchild's parent_session_id joined back to no task (#10873). The harness
// heartbeat interval is 60 s, so only the open's own state read can answer here.
describe("a hosted child's durable session id is known at spawn (#10873)", () => {
  for (const [label, model] of [["with a pinned model", "test/model"], ["without a model", undefined]] as const) {
    test(`#given a fresh host open ${label} #when the child starts #then its handle already carries the host's durable session id`, async () => {
      const host = await harness.fakeHost()
      const runner = harness.runnerOver(host)

      const handle = await runner.start(childSpec(model === undefined ? {} : { model }))

      if (!isHostSessionHandle(handle)) throw new Error("expected a host-session handle")
      expect(handle.sessionId).toBe(`durable-${handle.hostSession.routingId}`)
    })
  }
})
