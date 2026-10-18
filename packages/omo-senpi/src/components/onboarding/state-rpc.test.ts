import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  ONBOARDING_STATE_COMPLETE_RPC_METHOD,
  ONBOARDING_STATE_GET_RPC_METHOD,
  ONBOARDING_STATE_RESET_RPC_METHOD,
  type OnboardingStateResponse,
} from "./state-rpc"
import { createOnboardingHarness } from "./test-harness"
import * as state from "./state"

const dirs: string[] = []
afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for("omo.onboard"))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omo-onboarding-state-rpc-"))
  dirs.push(dir)
  return dir
}

function onboardingContexts(results: readonly unknown[]): number {
  return results.filter((result) => typeof result === "object" && result !== null && "message" in result).length
}

// Protocol contract (#10481): one completion flag, `onboarding/state.ts`, shared by the TUI and RPC clients.
describe("omo.onboarding.state.*", () => {
  test("#given a fresh install #when an RPC client completes onboarding #then the TUI never claims it again", async () => {
    const dir = stateDir()
    const desktop = createOnboardingHarness(dir, "desktop", "rpc")
    expect(await desktop.rpc(ONBOARDING_STATE_GET_RPC_METHOD)).toEqual({ completed: false, completedAt: null })

    const completed = await desktop.rpc(ONBOARDING_STATE_COMPLETE_RPC_METHOD) as OnboardingStateResponse
    expect(completed.completed).toBe(true)
    expect(typeof completed.completedAt).toBe("string")
    expect(state.isOnboardingComplete(dir)).toBe(true)

    const tui = createOnboardingHarness(dir, "tui", "tui")
    await tui.start()
    expect(onboardingContexts(await tui.prompt())).toBe(0)
    expect(tui.widgets.has("omo-onboarding")).toBe(false)
  })

  test("#given the TUI claimed onboarding #when an RPC client reads the state #then it reports completed", async () => {
    const dir = stateDir()
    const tui = createOnboardingHarness(dir, "tui", "tui")
    expect(onboardingContexts(await tui.prompt())).toBe(1)

    const read = await tui.rpc(ONBOARDING_STATE_GET_RPC_METHOD) as OnboardingStateResponse
    expect(read.completed).toBe(true)
    expect(Date.parse(read.completedAt ?? "")).not.toBeNaN()
  })

  test("#given a completed onboarding #when an RPC client resets it #then the next TUI prompt onboards again", async () => {
    const dir = stateDir()
    state.claimOnboarding(dir)
    const desktop = createOnboardingHarness(dir, "desktop", "rpc")
    expect(await desktop.rpc(ONBOARDING_STATE_RESET_RPC_METHOD)).toEqual({ completed: false, completedAt: null })

    const tui = createOnboardingHarness(dir, "tui", "tui")
    expect(onboardingContexts(await tui.prompt())).toBe(1)
  })

  test("#given an already completed onboarding #when complete is called again #then it stays completed with the first timestamp", async () => {
    const dir = stateDir()
    const desktop = createOnboardingHarness(dir, "desktop", "rpc")
    const first = await desktop.rpc(ONBOARDING_STATE_COMPLETE_RPC_METHOD) as OnboardingStateResponse
    const second = await desktop.rpc(ONBOARDING_STATE_COMPLETE_RPC_METHOD) as OnboardingStateResponse
    expect(second).toEqual(first)
  })
})
