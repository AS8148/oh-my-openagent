import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import type { PlanResolution } from "@oh-my-opencode/senpi-task"

import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import { loadSenpiOmoConfig } from "../config-resolution"
import { composeTaskEngine } from "./engine"
import { createTeamServiceTestModelRegistry } from "./team-service-test-model-registry"

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function writeCategoryModel(cwd: string, model: string): void {
  mkdirSync(join(cwd, ".omo"), { recursive: true })
  writeFileSync(join(cwd, ".omo", "omo.json"), `${JSON.stringify({ categories: { probe: { model } } })}\n`)
}

function plannedModel(resolution: PlanResolution): string | undefined {
  return resolution.kind === "resolved" ? resolution.plan.model : undefined
}

// A long-lived session keeps one engine for its whole life and /reload is vetoed while children run,
// so a category chain edited in omo.json must reach the NEXT spawn without a restart (#11355).
describe("task engine category chain per spawn", () => {
  test("#given omo.json changes a category's model between two spawns #when the second child is planned #then it uses the new model", () => {
    // given
    const cwd = mkdtempSync(join(tmpdir(), "omo-senpi-chain-per-spawn-"))
    tempRoots.push(cwd)
    writeCategoryModel(cwd, "acme/model-a")
    const engine = composeTaskEngine({
      pi: new FakeExtensionAPI(),
      omoConfig: loadSenpiOmoConfig({ cwd }).config,
      readOmoConfig: () => loadSenpiOmoConfig({ cwd }).config,
      cwd,
      sharedParentTools: () => [],
    })
    engine.runtime.captureFrom({ sessionManager: { getSessionId: () => "session-1" }, modelRegistry: createTeamServiceTestModelRegistry(["acme/model-a", "acme-b/model-b"]) })
    const spec = { prompt: "probe", parent_session_id: "session-1", depth: 0, category: "probe" }
    expect(plannedModel(engine.planner(spec))).toBe("acme/model-a")

    // when
    writeCategoryModel(cwd, "acme-b/model-b")

    // then
    expect(plannedModel(engine.planner(spec))).toBe("acme-b/model-b")
  })
})
