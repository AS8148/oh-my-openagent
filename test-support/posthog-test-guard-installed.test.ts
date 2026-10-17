import { describe, expect, spyOn, test } from "bun:test"
import { PostHog } from "posthog-node"

import { takePostHogTestGuardViolations } from "./posthog-test-guard"

// Proves the preload installed the guard on the real posthog-node prototype: without it, the flush
// below reaches the global fetch, which this test spies on so a missing guard fails instead of sending.
describe("PostHog test guard preload (#10394)", () => {
  test("#given a real PostHog client pointed at the PostHog cloud host #when it captures and flushes #then the send is refused before it reaches fetch", async () => {
    // given
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }))
    const flushLog = spyOn(console, "error").mockImplementation(() => undefined)
    const client = new PostHog("phc_test_guard_dummy_key", { host: "https://us.i.posthog.com", flushAt: 1, flushInterval: 0, fetchRetryCount: 0 })

    try {
      // when
      client.capture({ distinctId: "test-guard", event: "test_guard_probe" })
      const flushError: unknown = await client.flush().then(
        () => undefined,
        (error: unknown) => error,
      )
      await client.shutdown()

      // then
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(flushError).toBeDefined()
      const violations: string[] = takePostHogTestGuardViolations()
      expect(violations.length).toBeGreaterThan(0)
      expect(violations.every((violation) => violation.includes("sent product telemetry to https://us.i.posthog.com"))).toBe(true)
    } finally {
      flushLog.mockRestore()
      fetchSpy.mockRestore()
    }
  })
})
