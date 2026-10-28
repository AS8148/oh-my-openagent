import { afterEach, describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ManagedChildHandle, ManagedRunner, ManagedStartSpec, RunnerOutcome } from "@oh-my-opencode/senpi-task"
import * as dagEngine from "@oh-my-opencode/senpi-task/dag"
import { createDagManager } from "../../../../senpi-task/src/dag/manager"
import { createDagFileStore } from "../../../../senpi-task/src/dag/store"
import type { DagRunId } from "../../../../senpi-task/src/dag/types"

import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import { loadSenpiOmoConfig } from "../config-resolution"
import { createDagRuntime, type DagRuntime } from "./dag-runtime"
import { runDagTool } from "./dag-tool"
import { composeTaskEngine, type TaskEngine } from "./engine"
import { createTeamServiceTestModelRegistry } from "./team-service-test-model-registry"

// A long-lived orchestrator keeps one task engine for its whole session, and a workflow (DAG) node starts its child
// through that engine's planner. An omo.json category edit must reach the next node a workflow run starts, including a
// run recovered from disk, while a child already running keeps the model it was planned on (#11539).

const sessionId = "session-dag-category-config"
const MODEL_A = "acme/model-a"
const MODEL_B = "acme-b/model-b"
const createFileStore = createDagFileStore
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

function writeCategoryModel(project: string, model: string): void {
  fs.mkdirSync(join(project, ".omo"), { recursive: true })
  fs.writeFileSync(join(project, ".omo", "omo.json"), `${JSON.stringify({ categories: { quick: { model } } })}\n`)
}

class CapturingRunner implements ManagedRunner {
  readonly specs: ManagedStartSpec[] = []
  readonly #waiters = new Map<number, () => void>()

  start(spec: ManagedStartSpec): Promise<ManagedChildHandle> {
    this.specs.push(spec)
    this.#waiters.get(this.specs.length)?.()
    return Promise.resolve({
      task_id: spec.taskId,
      sessionId: `child-${spec.taskId}`,
      pid: undefined,
      steer: () => Promise.resolve(),
      followUp: () => Promise.resolve(),
      abort: () => Promise.resolve(),
      subscribe: () => () => undefined,
      // Children stay running: the test reads plans and records, never a completion.
      waitForOutcome: () => new Promise<RunnerOutcome>(() => {}),
      lastAssistantText: () => undefined,
      dispose: () => Promise.resolve(),
    })
  }

  // Failure ceiling, not synchronization: the start signal is subscribed before it can fire.
  whenStarted(count: number): Promise<void> {
    if (this.specs.length >= count) return Promise.resolve()
    const started = new Promise<void>((resolve) => this.#waiters.set(count, resolve))
    return Promise.race([
      started,
      new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error(`child ${count} did not start within 5000ms`)), 5_000)),
    ])
  }
}

type Fixture = {
  readonly engine: TaskEngine
  readonly runtime: DagRuntime
  readonly runner: CapturingRunner
}

function compose(project: string, home: string): Fixture {
  const env = { ...process.env, HOME: home, USERPROFILE: home }
  const runner = new CapturingRunner()
  const pi = Object.assign(new FakeExtensionAPI(), { rpc: { emit: () => undefined, handle: () => undefined } })
  const engine = composeTaskEngine({
    pi,
    omoConfig: loadSenpiOmoConfig({ cwd: project, env }).config,
    loadOmoConfig: () => loadSenpiOmoConfig({ cwd: project, env }),
    cwd: project,
    sharedParentTools: () => [],
    runnerFactories: { inProcess: () => runner, process: () => runner },
  })
  engine.runtime.captureFrom({
    mode: "tui",
    modelRegistry: createTeamServiceTestModelRegistry([MODEL_A, MODEL_B]),
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
    isIdle: () => false,
  })
  const createStore = spyOn(dagEngine, "createDagFileStore").mockImplementation((config, storeOptions = {}) =>
    createFileStore(config, { ...storeOptions, fsync: false }))
  try {
    const runtime = createDagRuntime({ pi, engine, logger: { info: () => undefined, warn: () => undefined, error: () => undefined } })
    return { engine, runtime, runner }
  } finally {
    createStore.mockRestore()
  }
}

async function startCategoryRun(runtime: DagRuntime, key: string): Promise<DagRunId> {
  const started = await runDagTool(
    {
      manager: runtime.manager,
      parentSessionId: () => sessionId,
      rootSessionId: () => sessionId,
      wait: runtime.wait,
      cancel: runtime.cancel,
      retry: runtime.retry,
      send: runtime.send,
      amend: runtime.amend,
    },
    { action: "start", definition: { key, name: key, nodes: [{ id: "work", prompt: "do work", category: "quick" }] } },
  )
  if (started.details.kind !== "started") throw new Error(`expected dag start, received ${started.details.kind}`)
  return started.details.run_id as DagRunId
}

function plannedRecord(fixture: Fixture, index: number) {
  const spec = fixture.runner.specs[index]
  if (spec === undefined) throw new Error(`child ${index} never started`)
  const record = fixture.engine.manager.get(spec.taskId)
  if (record === undefined) throw new Error(`no task record for ${spec.taskId}`)
  return { model: String(spec.model), requested: record.requested_model, generation: record.config_generation }
}

describe("workflow nodes plan on the live omo config (#11539)", () => {
  async function runBeforeAndAfterEdit(): Promise<Fixture> {
    const project = tempDir("omo-dag-category-config-")
    writeCategoryModel(project, MODEL_A)
    const fixture = compose(project, tempDir("omo-dag-category-home-"))
    await fixture.runtime.attach()
    await startCategoryRun(fixture.runtime, "before-edit")
    await fixture.runner.whenStarted(1)
    writeCategoryModel(project, MODEL_B)
    await startCategoryRun(fixture.runtime, "after-edit")
    await fixture.runner.whenStarted(2)
    return fixture
  }

  test("#given a workflow child running on category model A #when omo.json moves the category to model B and a new run starts #then its node plans on B and the running child keeps A", async () => {
    // given, when
    const fixture = await runBeforeAndAfterEdit()

    // then
    const before = plannedRecord(fixture, 0)
    const after = plannedRecord(fixture, 1)
    expect(after.model).toBe(MODEL_B)
    expect(after.requested).toMatchObject({ provider: "acme-b", model_id: "model-b", source: "category" })
    expect(before.model).toBe(MODEL_A)
    expect(before.requested).toMatchObject({ provider: "acme", model_id: "model-a", source: "category" })
    fixture.runtime.dispose()
  })

  test("#given a workflow child planned on generation 0 #when omo.json moves the category and a new run starts #then the new child record carries the next config generation", async () => {
    // given, when
    const fixture = await runBeforeAndAfterEdit()

    // then
    expect(plannedRecord(fixture, 0).generation).toBe(0)
    expect(plannedRecord(fixture, 1).generation).toBe(1)
    fixture.runtime.dispose()
  })

  test("#given a pending workflow run persisted on disk #when omo.json moves its category to model B before the session claims the run #then the recovered node plans on B", async () => {
    // given: the engine is composed at session start on model A, with a run a previous host left pending.
    const project = tempDir("omo-dag-category-recover-")
    writeCategoryModel(project, MODEL_A)
    const fixture = compose(project, tempDir("omo-dag-category-home-"))
    await createDagManager({
      store: createFileStore({ project_dir: project }, { fsync: false }),
      newRunId: () => "dag-category-recover" as DagRunId,
    }).start({
      parentSessionId: sessionId,
      rootSessionId: sessionId,
      definition: { key: "recover", name: "recover", nodes: [{ id: "resume", prompt: "resume", category: "quick" }] },
    })

    // when
    writeCategoryModel(project, MODEL_B)
    await fixture.runtime.attach()
    await fixture.runner.whenStarted(1)

    // then
    expect(plannedRecord(fixture, 0).model).toBe(MODEL_B)
    fixture.runtime.dispose()
  })
})

