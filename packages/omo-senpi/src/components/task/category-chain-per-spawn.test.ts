import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import type { ManagedChildHandle, ManagedRunner, ManagedStartSpec, RunnerOutcome } from "@oh-my-opencode/senpi-task"

import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import type { ComponentContext } from "../../extension/types"
import { loadSenpiOmoConfig } from "../config-resolution"
import { composeTaskEngine, type TaskEngine } from "./engine"
import { createTaskComponent } from "./index"
import { createTeamServiceTestModelRegistry } from "./team-service-test-model-registry"

// A long-lived session keeps one engine for its whole life and /reload is vetoed while children run, so an
// omo.json edit must reach the NEXT spawn, and a broken edit must fail that spawn rather than route it on
// another config (#11355).

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "omo-senpi-chain-per-spawn-"))
  tempRoots.push(dir)
  return dir
}

function writeOmoJson(cwd: string, text: string): void {
  mkdirSync(join(cwd, ".omo"), { recursive: true })
  writeFileSync(join(cwd, ".omo", "omo.json"), text)
}

const chain = (model: string): string => `${JSON.stringify({ categories: { quick: { model } } })}\n`
const BROKEN_LINE = '    "quick": { "model": "acme/model-a" oops }'
const BROKEN = `{\n  "categories": {\n${BROKEN_LINE}\n  }\n}\n`
const BROKEN_AT = { line: 3, column: BROKEN_LINE.indexOf("oops") + 1 }
const NOT_A_STRING = `${JSON.stringify({ categories: { quick: { model: 42 } } })}\n`

function idleHandle(spec: ManagedStartSpec): ManagedChildHandle {
  return {
    task_id: spec.taskId,
    sessionId: undefined,
    pid: undefined,
    steer: () => Promise.resolve(),
    followUp: () => Promise.resolve(),
    abort: () => Promise.resolve(),
    subscribe: () => () => {},
    waitForOutcome: () => new Promise<RunnerOutcome>(() => {}),
    lastAssistantText: () => undefined,
    dispose: () => Promise.resolve(),
  }
}

function composeCapturing(cwd: string, launched: string[]): TaskEngine {
  const capture: ManagedRunner = {
    start: (spec) => {
      launched.push(String(spec.model))
      return Promise.resolve(idleHandle(spec))
    },
  }
  const engine = composeTaskEngine({
    pi: new FakeExtensionAPI(),
    omoConfig: loadSenpiOmoConfig({ cwd }).config,
    loadOmoConfig: () => loadSenpiOmoConfig({ cwd }),
    cwd,
    sharedParentTools: () => [],
    runnerFactories: { inProcess: () => capture, process: () => capture },
  })
  engine.runtime.captureFrom({
    sessionManager: { getSessionId: () => "session-1" },
    modelRegistry: createTeamServiceTestModelRegistry(["acme/model-a", "acme-b/model-b"]),
  })
  return engine
}

const spawnQuick = (engine: TaskEngine) =>
  engine.manager.start({
    prompt: "do the thing",
    parent_session_id: "session-1",
    depth: 0,
    category: "quick",
    execution_mode: "in-process",
    run_in_background: true,
  })

describe("task engine omo config per spawn (#11355)", () => {
  test("#given omo.json broken, then invalid, then fixed between spawns #when each child is planned #then a broken or invalid layer fails the spawn with its file and position, never the startup chain, and the fixed file routes the next spawn", async () => {
    // given
    const cwd = tempProject()
    writeOmoJson(cwd, chain("acme/model-a"))
    const launched: string[] = []
    const engine = composeCapturing(cwd, launched)
    expect((await spawnQuick(engine)).kind).toBe("started")

    // when the file is half-edited
    writeOmoJson(cwd, BROKEN)
    const broken = await spawnQuick(engine)

    // then
    if (broken.kind !== "plan_unresolved") throw new Error(`expected a config error, got ${broken.kind}`)
    expect(broken.error.code).toBe("config_invalid")
    expect(broken.error.config_error).toMatchObject({ kind: "parse", position: BROKEN_AT })
    expect(broken.error.config_error?.path.endsWith(join(".omo", "omo.json"))).toBe(true)
    expect(broken.error.message).toContain(`${join(".omo", "omo.json")}:${BROKEN_AT.line}:${BROKEN_AT.column}`)

    // when a value has the wrong type
    writeOmoJson(cwd, NOT_A_STRING)
    const invalid = await spawnQuick(engine)

    // then
    if (invalid.kind !== "plan_unresolved") throw new Error(`expected a config error, got ${invalid.kind}`)
    expect(invalid.error.code).toBe("config_invalid")
    expect(invalid.error.config_error).toMatchObject({ kind: "validation", issue_paths: ["categories.quick.model"] })
    expect(invalid.error.message).toContain("at categories.quick.model")

    // when the file is fixed with a new chain
    writeOmoJson(cwd, chain("acme-b/model-b"))
    const fixed = await spawnQuick(engine)

    // then only the valid configs launched children: never the startup chain for the broken or invalid file
    expect(fixed.kind).toBe("started")
    expect(launched).toEqual(["acme/model-a", "acme-b/model-b"])
  })
})

describe("task component omo config wiring (#11355)", () => {
  function ctxFor(pi: FakeExtensionAPI): ComponentContext {
    return {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      config: { getFlag: (name) => pi.getFlag(name) },
      getCapturedTools: () => [],
    }
  }

  test("#given the registered task tool #when it spawns twice against a broken omo.json #then each spawn loads omo config exactly once and fails naming the file and position", async () => {
    // given
    const cwd = tempProject()
    writeOmoJson(cwd, chain("acme/model-a"))
    const pi = new FakeExtensionAPI()
    pi.cwd = cwd
    let loads = 0
    await createTaskComponent({
      resolveCwd: () => cwd,
      loadConfig: (options = {}) => {
        loads += 1
        return loadSenpiOmoConfig(options)
      },
    }).register(pi, ctxFor(pi))
    const tool = pi.tools.find((candidate) => candidate.name === "task") as
      | { execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; details: { status: string } }> }
      | undefined
    if (tool === undefined) throw new Error("task tool not registered")
    writeOmoJson(cwd, BROKEN)
    const spawn = () =>
      tool.execute(
        "call-1",
        { prompt: "do the thing", category: "quick", run_in_background: true, load_skills: [] },
        undefined,
        undefined,
        { cwd, sessionManager: { getSessionId: () => "session-1" } },
      )

    // when
    const before = loads
    const first = await spawn()
    const afterFirst = loads
    const second = await spawn()

    // then
    expect(afterFirst - before).toBe(1)
    expect(loads - afterFirst).toBe(1)
    for (const result of [first, second]) {
      expect(result.details.status).toBe("plan_error")
      expect(result.content.map((part) => part.text).join("")).toContain(`${join(".omo", "omo.json")}:${BROKEN_AT.line}:${BROKEN_AT.column}`)
    }
  })
})
