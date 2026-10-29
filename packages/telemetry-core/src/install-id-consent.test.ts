import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DEFAULT_POSTHOG_API_KEY, DEFAULT_POSTHOG_HOST, recordDailyActive } from "./index"
import type { TelemetryOsProvider, TelemetryProductConfig, TelemetryTransportFactory } from "./index"
import { TELEMETRY_INSTALL_ID_FILE_NAME } from "./install-id"

const PRODUCT = {
  cacheDirName: "omo-codex",
  defaultApiKey: DEFAULT_POSTHOG_API_KEY,
  defaultHost: DEFAULT_POSTHOG_HOST,
  eventName: "omo_codex_daily_active",
  packageName: "@oh-my-opencode/omo-codex",
  packageVersion: "4.9.2",
  platform: "omo-codex",
  productName: "omo-codex",
  productEnvPrefix: "OMO_CODEX",
} satisfies TelemetryProductConfig

const OS_PROVIDER = {
  arch: () => "arm64",
  cpus: () => [{ model: "Apple M-test" }],
  hostname: () => "test-host",
  platform: () => "darwin",
  release: () => "26.0.0",
  totalmem: () => 17_179_869_184,
  type: () => "Darwin",
} satisfies TelemetryOsProvider

async function recordWith(env: Record<string, string>): Promise<{ captured: number; installIdExists: boolean }> {
  const root = mkdtempSync(join(tmpdir(), "telemetry-install-id-consent-"))
  const stateDir = join(root, "state")
  let captured = 0
  const transportFactory: TelemetryTransportFactory = () => ({
    capture: () => {
      captured += 1
    },
    flush: async () => undefined,
    shutdown: async () => undefined,
  })
  try {
    await recordDailyActive({
      env: { POSTHOG_API_KEY: "test-key", ...env },
      now: new Date("2026-05-25T01:02:03.000Z"),
      osProvider: OS_PROVIDER,
      product: PRODUCT,
      reason: "session_start",
      source: "plugin",
      stateDir,
      transportFactory,
    })
    return { captured, installIdExists: existsSync(join(stateDir, TELEMETRY_INSTALL_ID_FILE_NAME)) }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe("install id and telemetry consent (#11583)", () => {
  test("#given telemetry is on #when daily active records #then the install id file is created and one event is captured", async () => {
    // when
    const result = await recordWith({})

    // then
    expect(result).toEqual({ captured: 1, installIdExists: true })
  })

  test.each([
    ["DO_NOT_TRACK", { DO_NOT_TRACK: "1" }],
    ["OMO_DISABLE_TELEMETRY", { OMO_DISABLE_TELEMETRY: "1" }],
    ["OMO_DISABLE_POSTHOG", { OMO_DISABLE_POSTHOG: "1" }],
    ["OMO_SEND_ANONYMOUS_TELEMETRY=0", { OMO_SEND_ANONYMOUS_TELEMETRY: "0" }],
    ["the product-level OMO_CODEX_DISABLE_POSTHOG", { OMO_CODEX_DISABLE_POSTHOG: "1" }],
  ] as const)("#given %s #when daily active records #then no install id file is created and nothing is captured", async (_name, env) => {
    // when
    const result = await recordWith(env)

    // then
    expect(result).toEqual({ captured: 0, installIdExists: false })
  })
})
