import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

import type { TelemetryCaptureMessage, TelemetryTransportFactory } from "@oh-my-opencode/telemetry-core"
import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import { createOmoNativeTelemetryComponent } from "./omo-native-component"
import { summaryDir } from "./session-summary-storage"
import {
  FIXED_NOW,
  createEnabledEnv,
  createOsProvider,
  createRejectingTransportRecorder,
  createSilentLogger,
  createTransportRecorder,
  withTempAgentDir,
} from "./telemetry.test-support"

// Ack contract at the real transport boundary: session_summary carries its window id as the PostHog event
// uuid, its pending file is deleted only after the transport's flush resolves, and a failed flush leaves it
// to be re-sent, under the same uuid, by the next registration that captures.

function turnEnd(): Record<string, unknown> {
  return {
    type: "turn_end",
    turnIndex: 0,
    message: {
      role: "assistant", content: [], provider: "openai", model: "gpt-5.6-sol", stopReason: "stop", timestamp: 1,
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0.0002 } },
    },
    toolResults: [],
  }
}

async function runSession(agentDir: string, factory: TelemetryTransportFactory, withTurn: boolean): Promise<void> {
  const pi = new FakeExtensionAPI()
  const session = { cwd: "/repo", sessionManager: { getSessionId: () => (withTurn ? "ack-session" : "later-session") } }
  createOmoNativeTelemetryComponent({
    rawTurnSampleRate: 0,
    env: createEnabledEnv(agentDir),
    hashSessionId: (raw) => `hashed:${raw}`,
    isConfigEnabled: () => true,
    now: FIXED_NOW,
    osProvider: createOsProvider("ack-host"),
    stateDir: join(agentDir, "omo-senpi", "omo-native"),
    transportFactory: factory,
  }).register(pi, { config: pi, logger: createSilentLogger() })
  await pi.dispatch("session_start", { type: "session_start", reason: "startup" }, session)
  if (withTurn) await pi.dispatch("turn_end", turnEnd(), session)
  await pi.dispatch("session_shutdown", { type: "session_shutdown", reason: "quit" }, session)
}

function pendingOf(agentDir: string): string[] {
  const dir = join(summaryDir(join(agentDir, "omo-senpi", "omo-native")), "pending")
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")) : []
}

const summariesOf = (messages: readonly TelemetryCaptureMessage[]) => messages.filter(({ event }) => event === "session_summary")

describe("session_summary acknowledgment through the native transport", () => {
  test("#given an acknowledging transport #when the session quits #then the summary carries a uuid and no pending file is left", async () => {
    await withTempAgentDir(async (agentDir) => {
      const recorder = createTransportRecorder()
      await runSession(agentDir, recorder.factory, true)

      const summaries = summariesOf(recorder.messages)
      expect(summaries).toHaveLength(1)
      expect(summaries[0]?.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      expect(summaries[0]?.properties).toMatchObject({ cost_1e4: 2, cost_usd: 0.0002, dropped_events: 0 })
      expect(pendingOf(agentDir)).toEqual([])
    })
  })

  test("#given a transport whose flush fails #when a later session captures #then the same uuid is sent again and then retired", async () => {
    await withTempAgentDir(async (agentDir) => {
      const failed: TelemetryCaptureMessage[] = []
      await runSession(agentDir, createRejectingTransportRecorder(failed), true)
      const firstUuid = summariesOf(failed)[0]?.uuid
      expect(firstUuid).toBeString()
      expect(pendingOf(agentDir)).toEqual([`${firstUuid}.json`])

      const pending: unknown = JSON.parse(readFileSync(join(summaryDir(join(agentDir, "omo-senpi", "omo-native")), "pending", `${firstUuid}.json`), "utf8"))

      const recorder = createTransportRecorder()
      await runSession(agentDir, recorder.factory, false)
      const resent = summariesOf(recorder.messages)
      expect(resent.map(({ uuid }) => uuid)).toEqual([firstUuid])
      expect(pendingOf(agentDir)).toEqual([])

      // The re-send keeps the original event time, so PostHog's (uuid, day) dedup key stays the same.
      const createdAt = Reflect.get(pending as object, "createdAt")
      expect(summariesOf(failed)[0]?.timestamp?.getTime()).toBe(createdAt)
      expect(resent[0]?.timestamp?.getTime()).toBe(createdAt)
    })
  })
})
