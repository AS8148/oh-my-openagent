import { describe, expect, test } from "bun:test"

import { classifyReflectionLockHolder, isLocalHost } from "./stale-holder"
import { REFLECTION_DIR, SCENARIOS, probeFor } from "./stale-holder.scenarios.test-support"

describe("reflection lock holder decision (#10377)", () => {
  // Each fail-closed rule has its own scenario that changes exactly one fact of a provably dead
  // holder, so removing that rule changes this scenario's verdict.
  test.each(SCENARIOS.map((scenario) => [scenario.rule === undefined ? scenario.name : `${scenario.name} [rule:${scenario.rule}]`, scenario] as const))(
    "#given %s #when the holder is classified #then the verdict is exact",
    async (_name, scenario) => {
      expect(await classifyReflectionLockHolder(REFLECTION_DIR, probeFor(scenario.facts))).toEqual(scenario.expected)
    },
  )

  test("#given a start-identity reader that throws #when the launcher is alive #then it stays live instead of failing", async () => {
    const scenario = SCENARIOS.find((entry) => entry.rule === "pid-reused")
    if (scenario === undefined) throw new Error("missing scenario")
    const probe = { ...probeFor(scenario.facts), getProcessStartIdentity: async () => { throw new Error("ps failed") } }
    expect(await classifyReflectionLockHolder(REFLECTION_DIR, probe)).toEqual({ state: "live", runId: "reflection-run-64" })
  })

  describe("macOS dynamic DHCP hostname churn (#10377)", () => {
    test("#given DHCP reverse-DNS hostnames on Darwin #when checked #then they are recognized as local", () => {
      expect(isLocalHost("Mac-765", "Mac-424", "darwin")).toBe(true)
      expect(isLocalHost("Mac-108", "Mac-108", "darwin")).toBe(true)
      expect(isLocalHost("remote-server.corp", "Mac-424", "darwin")).toBe(false)
      expect(isLocalHost("Mac-765", "Mac-424", "linux")).toBe(false)
    })

    test("#given an interrupted reflection run under previous DHCP hostname on Darwin #when classified #then it reclaims as dead", async () => {
      const baseScenario = SCENARIOS.find((s) => s.rule === undefined)
      if (!baseScenario) throw new Error("missing base scenario")
      const facts = {
        ...baseScenario.facts,
        files: {
          ...baseScenario.facts.files,
          [`${REFLECTION_DIR}/active.lock`]: JSON.stringify({
            runId: "reflection-run-64",
            launcherPid: 11096,
            launcherHostname: "Mac-765",
          }),
        },
      }
      const probe = {
        ...probeFor(facts),
        hostname: () => "Mac-424",
        isLocalHost: (target: string, current: string) => isLocalHost(target, current, "darwin"),
      }
      expect(await classifyReflectionLockHolder(REFLECTION_DIR, probe)).toEqual({
        state: "dead",
        runId: "reflection-run-64",
      })
    })

    test("#given a truly remote host #when classified #then it stays safely stuck", async () => {
      const otherHostScenario = SCENARIOS.find((s) => s.rule === "other-host")
      if (!otherHostScenario) throw new Error("missing other-host scenario")
      const probe = {
        ...probeFor(otherHostScenario.facts),
        hostname: () => "Mac-424",
        isLocalHost: (target: string, current: string) => isLocalHost(target, current, "darwin"),
      }
      expect(await classifyReflectionLockHolder(REFLECTION_DIR, probe)).toEqual({
        state: "stuck",
        runId: "reflection-run-64",
        reason: "it is owned by host other-host, which cannot be checked from here",
      })
    })
  })
})
