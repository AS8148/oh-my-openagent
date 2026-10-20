import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { TelemetryEnv } from "@oh-my-opencode/telemetry-core"

import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import { createOmoNativeTelemetryComponent } from "./omo-native-component"
import { summaryDir } from "./session-summary-purge"
import { FIXED_NOW, createEnabledEnv, createOsProvider, createSilentLogger, withTempAgentDir } from "./telemetry.test-support"

// Privacy promise (lead, 2026-10-20): with telemetry off, nothing telemetry-related loads and nothing is
// written. The spies stand in for the only two ways telemetry code is reached: the summary sidecar import
// and the transport factory. The first-run case is the desktop's placeholder `telemetry.enabled: false`,
// read through the real config loader before the user answered.

const DISABLED: readonly (readonly [string, (agentDir: string) => { readonly env: TelemetryEnv; readonly isConfigEnabled?: () => boolean }])[] = [
  ["OMO_DISABLE_TELEMETRY=1", (agentDir) => ({ env: { ...createEnabledEnv(agentDir), OMO_DISABLE_TELEMETRY: "1" }, isConfigEnabled: () => true })],
  ["telemetry.enabled false in config", (agentDir) => ({ env: createEnabledEnv(agentDir), isConfigEnabled: () => false })],
  ["first run before consent (placeholder config)", (agentDir) => {
    mkdirSync(join(agentDir, ".omo"), { recursive: true })
    writeFileSync(join(agentDir, ".omo", "omo.jsonc"), JSON.stringify({ telemetry: { enabled: false } }))
    return { env: { ...createEnabledEnv(agentDir), HOME: agentDir } }
  }],
]

// Every export of the sidecar is replaced by a stub that counts a use, whichever code path imported it.
// (Bun copies a mock factory's own keys, so the stub names each export; the shared test setup restores
// module mocks after every test, so it is registered before each one.)
const sidecarLoads = { count: 0 }
const SIDECAR_EXPORTS = ["adoptForeignWindow","withRecoveryOps","sendSummaryRecord","createImmediateSender","createSessionSummaryRecorder","createSummaryStorage","currentProcessOwner","PENDING_CAP","PENDING_CAP_BYTES","RESENDS_PER_SWEEP","RESEND_BACKOFF_MS","createSummaryRecovery","createRecoveryRuntime","purgeUnconsentedQueue"] as const
afterEach(() => {
  mock.restore()
})
beforeEach(() => {
  mock.module("#omo-telemetry-recovery-runtime", () =>
    Object.fromEntries(SIDECAR_EXPORTS.map((name) => [name, () => {
      sidecarLoads.count += 1
      throw new Error(`the summary sidecar's ${name} must not be used while telemetry is off`)
    }])))
})

function context(sessionId: string): Record<string, unknown> {
  return { sessionManager: { getSessionId: () => sessionId } }
}

function turnEnd(): Record<string, unknown> {
  return {
    type: "turn_end",
    turnIndex: 1,
    message: {
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.6-sol",
      usage: {
        input: 11,
        output: 22,
        cacheRead: 3,
        cacheWrite: 4,
        reasoning: 5,
        totalTokens: 40,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.123456 },
      },
      stopReason: "stop",
      timestamp: 1,
    },
    toolResults: [],
  }
}

async function runDisabledSession(agentDir: string, stateDir: string, setup: ReturnType<(typeof DISABLED)[number][1]>) {
  const loads = { sidecar: 0, transport: 0 }
  const before = sidecarLoads.count
  const pi = new FakeExtensionAPI()
  createOmoNativeTelemetryComponent({
    ...setup,
    rawTurnSampleRate: 1,
    now: FIXED_NOW,
    osProvider: createOsProvider("disabled-host"),
    scheduleConsentCheck: () => () => undefined,
    stateDir,
    transportFactory: () => {
      loads.transport += 1
      throw new Error("no transport may be built while telemetry is off")
    },
  }).register(pi, { config: pi, logger: createSilentLogger() })
  await pi.dispatch("session_start", { type: "session_start", reason: "startup" }, context("off"))
  await pi.dispatch("turn_end", turnEnd(), context("off"))
  await pi.dispatch("turn_end", turnEnd(), context("off"))
  await pi.dispatch("session_shutdown", { type: "session_shutdown", reason: "quit" }, context("off"))
  loads.sidecar = sidecarLoads.count - before
  return loads
}

describe("telemetry turned off loads and writes nothing", () => {
  for (const [label, disable] of DISABLED) {
    test(`#given ${label} #when a session starts, runs two turns and quits #then the sidecar and the transport never load and the state dir stays empty`, async () => {
      await withTempAgentDir(async (agentDir) => {
        const stateDir = join(agentDir, "omo-senpi", "omo-native")

        const loads = await runDisabledSession(agentDir, stateDir, disable(agentDir))

        expect(loads).toEqual({ sidecar: 0, transport: 0 })
        expect(existsSync(stateDir) ? readdirSync(stateDir, { recursive: true }) : []).toEqual([])
      })
    })
  }

  test("#given a summary queue an earlier opted-in run left #when a machine-wide opt-out session quits #then the whole queue is deleted without loading the sidecar", async () => {
    await withTempAgentDir(async (agentDir) => {
      const stateDir = join(agentDir, "omo-senpi", "omo-native")
      const pending = join(summaryDir(stateDir), "pending")
      mkdirSync(pending, { recursive: true })
      const record = { v: 2, consent: "enabled", scope: {}, uuid: "0b6c5d3e-2f1a-4c8b-9d7e-6a5b4c3d2e1f" }
      writeFileSync(join(pending, `${record.uuid}.json`), JSON.stringify(record))
      writeFileSync(join(summaryDir(stateDir), "hashed_old.json"), JSON.stringify({ v: 2, consent: "enabled", scope: {} }))

      const loads = await runDisabledSession(agentDir, stateDir, DISABLED[0]![1](agentDir))

      expect(loads).toEqual({ sidecar: 0, transport: 0 })
      expect(existsSync(summaryDir(stateDir))).toBe(false)
    })
  })
})
