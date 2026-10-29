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

    // No `hostname` and no `isLocalHost`: only the scutil result is injected, so the production
    // hostname read and the production comparison both run. A record from another machine must stay
    // foreign even when its pid happens to be alive in this process table.
    test("#given the production comparison over an injected scutil result #when the lock belongs to another machine #then it stays stuck", async () => {
      const facts = {
        files: {
          [`${REFLECTION_DIR}/active.lock`]: JSON.stringify({
            runId: "reflection-run-64",
            launcherPid: 11096,
            launcherHostname: "their-mac",
            launcherHostId: "their-machine",
          }),
          [`${REFLECTION_DIR}/runs/reflection-run-64/outcome.json`]: JSON.stringify({
            version: 1,
            runId: "reflection-run-64",
            attempt: 1,
            finishedAt: "2026-10-17T00:00:00.000Z",
            childExit: { code: 0, signal: null },
            timedOut: false,
          }),
        },
        pids: { 11096: "alive" as const },
        starts: {},
      }
      const fixtures = probeFor(facts)
      const probe = {
        readText: fixtures.readText,
        getPidLiveness: fixtures.getPidLiveness,
        getProcessStartIdentity: fixtures.getProcessStartIdentity,
        hostId: () => "our-machine",
      }
      expect(await classifyReflectionLockHolder(REFLECTION_DIR, probe)).toEqual({
        state: "stuck",
        runId: "reflection-run-64",
        reason: "it is owned by host their-mac, which cannot be checked from here",
      })
    })
  })
})
