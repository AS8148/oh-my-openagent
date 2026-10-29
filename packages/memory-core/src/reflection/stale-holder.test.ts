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

  describe("stable host identity across roaming and multi-device sync (#11818)", () => {
    test("#given two different Mac-NNN hosts with different ids #when checked #then they stay foreign", () => {
      expect(
        isLocalHost(
          { hostname: "Mac-765", hostId: "mac-a" },
          { hostname: "Mac-424", hostId: "mac-b" },
        ),
      ).toBe(false)
    })

    test("#given another machine's record whose pid is alive there #when classified #then it stays stuck and is never cleared", async () => {
      const baseScenario = SCENARIOS.find((s) => s.rule === undefined)
      if (!baseScenario) throw new Error("missing base scenario")
      const facts = {
        ...baseScenario.facts,
        files: {
          ...baseScenario.facts.files,
          [`${REFLECTION_DIR}/active.lock`]: JSON.stringify({
            runId: "reflection-run-64",
            launcherPid: 11096,
            launcherHostname: "remote-mac",
            launcherHostId: "host-remote-123",
          }),
        },
        pids: {
          11096: "alive" as const,
        },
      }
      const probe = {
        ...probeFor(facts),
        hostname: () => "Mac-424",
        hostId: () => "host-local-456",
      }
      expect(await classifyReflectionLockHolder(REFLECTION_DIR, probe)).toEqual({
        state: "stuck",
        runId: "reflection-run-64",
        reason: "it is owned by host remote-mac, which cannot be checked from here",
      })
    })

    test("#given a legacy record with only the old hostname field #when checked #then it matches only when equal to os.hostname()", () => {
      expect(
        isLocalHost(
          { hostname: "my-workstation" },
          { hostname: "my-workstation", hostId: "host-123" },
        ),
      ).toBe(true)
      expect(
        isLocalHost(
          { hostname: "old-hostname" },
          { hostname: "new-hostname", hostId: "host-123" },
        ),
      ).toBe(false)
    })

    test("#given the DHCP-rename case from #11818 with same hostId and different hostname #when classified #then it is reclaimed as dead", async () => {
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
            launcherHostId: "MacBook-Pro",
          }),
        },
      }
      const probe = {
        ...probeFor(facts),
        hostname: () => "Mac-424",
        hostId: () => "MacBook-Pro",
      }
      expect(await classifyReflectionLockHolder(REFLECTION_DIR, probe)).toEqual({
        state: "dead",
        runId: "reflection-run-64",
      })
    })
  })
})
