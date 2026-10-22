import { describe, expect, test } from "bun:test"

import { createFallbackSessionHarness, FALLBACK_PROVIDER } from "./__fixtures__/in-process-fallback-session"

const quotaError =
  `403: {"message":"You've reached your usage limit for this billing cycle.",` +
  `"type":"access_terminated_error"}`

describe("in-process access_terminated_error fallback", () => {
  test("#given access_terminated_error makes the first category candidate unusable #when the child runs #then the next configured candidate produces the result", async () => {
    // given
    const harness = await createFallbackSessionHarness(quotaError)

    // when
    try {
      await harness.session.prompt("complete through the configured fallback")

      // then
      expect(harness.calls).toEqual(["dead-primary", "healthy-fallback"])
      expect(harness.session.getLastAssistantText()).toBe("fallback completed")
      // senpi 2026.9.29 (senpi #2319) tags a switch caused by a usage limit with its scope;
      // "reached your usage limit for this billing cycle" names no model, so it is account-wide.
      expect(harness.events).toContainEqual({
        type: "retry_fallback_applied",
        from: "runtime-fallback-test/dead-primary",
        to: `${FALLBACK_PROVIDER}/healthy-fallback`,
        chainKey: "runtime-fallback-test/dead-primary",
        reason: "billing",
        limit: "account",
      })
    } finally {
      harness.dispose()
    }
  }, 20_000)

  test("#given context overflow is deliberately non-fallback #when the child runs #then it stays terminal on the first candidate", async () => {
    // given
    const harness = await createFallbackSessionHarness(
      "Your input exceeds the context window of this model",
    )

    // when
    try {
      await harness.session.prompt("do not advance this overflow")

      // then
      // senpi 2026.10.21-3 recovers an overflow by compacting and retrying the SAME model: each rung
      // of OVERFLOW_RECOVERY_RUNGS (agent-session.ts:441, checked at :9321, counted at :9342) is one
      // retry. Since the forced-progress cut search in compaction.ts (prepareCompaction, senpi#3961)
      // this harness's first rung finds a cut, so exactly one recovery retry runs before the turn ends.
      // Context overflow still never moves to the next fallback candidate.
      expect(harness.calls).toEqual(["dead-primary", "dead-primary"])
      expect(harness.events.some((event) => event.type === "retry_fallback_applied")).toBe(false)
      expect(harness.session.getLastAssistantText()).toBeUndefined()
    } finally {
      harness.dispose()
    }
  })
})
