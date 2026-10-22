import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { RunnerError } from "../runners/in-process"
import type { ResolvedModelRecord } from "../state"
import type { ManagedChildHandle } from "./child-handle"
import type { ChildPlanner, ManagedStartSpec } from "./types"
import { FakeRunner, cleanupProjects, flush, makeManager, settings } from "./__fixtures__/manager-fakes"
import { bounded } from "../lifecycle/__fixtures__/live-parent-clock"
import { readEvents } from "../lifecycle/__fixtures__/lifecycle-fakes"

const PACKAGE_MODEL: ResolvedModelRecord = {
  provider: "glm-zcode",
  model_id: "glm-5.3",
  display: "glm-zcode/glm-5.3",
  reasoning_effort: "max",
  source: "category",
}

const BUILTIN_MODEL: ResolvedModelRecord = {
  provider: "xai",
  model_id: "grok-4.6",
  display: "xai/grok-4.6",
  reasoning_effort: "xhigh",
  source: "category",
}

function chainPlanner(fallbacks: readonly ResolvedModelRecord[]): ChildPlanner {
  return () => ({
    kind: "resolved",
    plan: {
      model: PACKAGE_MODEL.display,
      resolved_model: PACKAGE_MODEL,
      category: "unspecified-high",
      ...(fallbacks.length === 0 ? {} : { fallback_models: fallbacks }),
    },
  })
}

// A runner that refuses named models the way `createRpcModelAdmission` does - before any child
// exists - and serves every other model normally.
class AdmissionRefusingRunner extends FakeRunner {
  constructor(private readonly refused: ReadonlySet<string>, private readonly kind: "model_unavailable" | "depth-exceeded" = "model_unavailable") {
    super()
  }

  override start(spec: ManagedStartSpec): Promise<ManagedChildHandle> {
    if (this.refused.has(spec.model ?? "")) {
      this.startedSpecs.push(spec)
      throw new RunnerError({
        kind: this.kind,
        ...(this.kind === "model_unavailable" ? { reason: "model_not_in_child_profile" as const } : {}),
        message: `process model admission failed for ${spec.model}: model is not visible in the child profile`,
      })
    }
    return super.start(spec)
  }
}

// Refuses the first chain model: at once for the first task (it falls back and holds the fallback lane),
// and for every later task only once `refuse` is called, after the start window has elapsed.
class LateRefusingRunner extends FakeRunner {
  readonly #refusal = Promise.withResolvers<void>()
  #refusals = 0
  readonly #admitted = new Map<string, PromiseWithResolvers<void>>()

  refuse(): void {
    this.#refusal.resolve()
  }

  admitted(taskId: string): Promise<void> {
    const pending = this.#admitted.get(taskId) ?? Promise.withResolvers<void>()
    this.#admitted.set(taskId, pending)
    return pending.promise
  }

  override start(spec: ManagedStartSpec): Promise<ManagedChildHandle> {
    if (spec.model !== PACKAGE_MODEL.display) {
      return super.start(spec).then((handle) => {
        void this.admitted(spec.taskId)
        this.#admitted.get(spec.taskId)?.resolve()
        return handle
      })
    }
    this.startedSpecs.push(spec)
    this.#refusals += 1
    return (this.#refusals === 1 ? Promise.resolve() : this.#refusal.promise).then(() => {
      throw new RunnerError({ kind: "model_unavailable", reason: "model_not_in_child_profile", message: `refused ${spec.model}` })
    })
  }
}

afterEach(cleanupProjects)

describe("category chain fallback on a start-time admission refusal", () => {
  test("#given the first chain model is refused at admission #when the task starts #then the child launches on the next chain entry", async () => {
    // given
    const runner = new AdmissionRefusingRunner(new Set([PACKAGE_MODEL.display]))
    const { manager, store } = makeManager({ planner: chainPlanner([BUILTIN_MODEL]), inProcess: runner })

    // when
    const result = await manager.start({
      prompt: "work",
      parent_session_id: "parent-1",
      depth: 1,
      category: "unspecified-high",
    })

    // then
    if (result.kind !== "started") throw new Error(`expected started, got ${JSON.stringify(result)}`)
    expect(result.status).toBe("running")
    expect(runner.startedSpecs.map((spec) => spec.model)).toEqual([PACKAGE_MODEL.display, BUILTIN_MODEL.display])

    const record = store.load(result.task_id)
    expect(record?.model).toBe(BUILTIN_MODEL.display)
    expect(record?.resolved_model).toEqual(BUILTIN_MODEL)
    expect(record?.fallback_models ?? []).toEqual([])
    expect(record?.fallback_attempts).toEqual([PACKAGE_MODEL, BUILTIN_MODEL])
    expect(result.resolved_model).toEqual(BUILTIN_MODEL)
    expect(result.run_epoch).toBe(record?.notification.run_epoch)

    const eventLog = readFileSync(join(store.stateDir, "logs", `${result.task_id}.jsonl`), "utf8")
    expect(eventLog).toContain('"type":"task_model_fallback"')
    expect(eventLog).toContain(`"from_model":"${PACKAGE_MODEL.display}"`)
    expect(eventLog).toContain(`"to_model":"${BUILTIN_MODEL.display}"`)
  })

  test("#given two refused models ahead of a servable one #when the task starts #then the chain is walked to the first servable entry", async () => {
    // given
    const second: ResolvedModelRecord = { ...PACKAGE_MODEL, model_id: "glm-5.3-flash", display: "glm-zcode/glm-5.3-flash" }
    const runner = new AdmissionRefusingRunner(new Set([PACKAGE_MODEL.display, second.display]))
    const { manager, store } = makeManager({ planner: chainPlanner([second, BUILTIN_MODEL]), inProcess: runner })

    // when
    const result = await manager.start({ prompt: "work", parent_session_id: "parent-1", depth: 1, category: "unspecified-high" })

    // then
    if (result.kind !== "started") throw new Error(`expected started, got ${JSON.stringify(result)}`)
    expect(runner.startedSpecs.map((spec) => spec.model)).toEqual([
      PACKAGE_MODEL.display,
      second.display,
      BUILTIN_MODEL.display,
    ])
    expect(store.load(result.task_id)?.model).toBe(BUILTIN_MODEL.display)
  })

  test("#given every chain model is refused #when the task starts #then the task fails with the model-unavailable classification", async () => {
    // given
    const runner = new AdmissionRefusingRunner(new Set([PACKAGE_MODEL.display, BUILTIN_MODEL.display]))
    const { manager } = makeManager({ planner: chainPlanner([BUILTIN_MODEL]), inProcess: runner })

    // when
    const result = await manager.start({ prompt: "work", parent_session_id: "parent-1", depth: 1, category: "unspecified-high" })

    // then
    if (result.kind !== "start_failed") throw new Error("expected start_failed")
    expect(result.failure_kind).toBe("model_unavailable")
    expect(result.error_message).toBe(
      "The task child cannot serve this model: its provider is not present in the child profile.",
    )
    expect(runner.startedSpecs.map((spec) => spec.model)).toEqual([PACKAGE_MODEL.display, BUILTIN_MODEL.display])
  })

  test("#given a start failure that is not an admission refusal #when the task starts #then the chain is left alone", async () => {
    // given: only model_unavailable means "this child cannot serve it"; a depth refusal would fail
    // identically on every other entry, so walking the chain would just multiply the same failure.
    const runner = new AdmissionRefusingRunner(new Set([PACKAGE_MODEL.display]), "depth-exceeded")
    const { manager } = makeManager({ planner: chainPlanner([BUILTIN_MODEL]), inProcess: runner })

    // when
    const result = await manager.start({ prompt: "work", parent_session_id: "parent-1", depth: 1, category: "unspecified-high" })

    // then
    if (result.kind !== "start_failed") throw new Error("expected start_failed")
    expect(result.error_message).toBe("In-process child depth limit exceeded.")
    expect(runner.startedSpecs.map((spec) => spec.model)).toEqual([PACKAGE_MODEL.display])
  })

  test("#given a refused model with no chain left #when the task starts #then it fails without pretending to fall back", async () => {
    // given
    const runner = new AdmissionRefusingRunner(new Set([PACKAGE_MODEL.display]))
    const { manager, store } = makeManager({ planner: chainPlanner([]), inProcess: runner })

    // when
    const result = await manager.start({ prompt: "work", parent_session_id: "parent-1", depth: 1, category: "unspecified-high" })

    // then
    if (result.kind !== "start_failed") throw new Error("expected start_failed")
    expect(runner.startedSpecs).toHaveLength(1)
    const eventLog = readFileSync(join(store.stateDir, "logs", `${result.task_id}.jsonl`), "utf8")
    expect(eventLog).not.toContain("task_model_fallback")
  })

  test("#given a task that fell back at start and then completed #when a later task needs the same lane #then the slot was released and it starts immediately", async () => {
    // given: one slot per lane, so a leaked lease on the fallback model would park the second task.
    // `#releaseSlot` is guarded per (task, epoch), which is exactly what a naive in-place retry breaks.
    const runner = new AdmissionRefusingRunner(new Set([PACKAGE_MODEL.display]))
    const { manager, store } = makeManager({
      planner: chainPlanner([BUILTIN_MODEL]),
      inProcess: runner,
      config: settings({ default_concurrency: 1, max_depth: 1 }),
    })
    const first = await manager.start({ prompt: "work", parent_session_id: "parent-1", depth: 1, category: "unspecified-high" })
    if (first.kind !== "started") throw new Error("expected the first task to start on the fallback model")

    // when: the fallback child finishes, which must release the lease it actually holds
    runner.handles.get(first.task_id)?.settle({ status: "completed", finalResponse: "done" })
    await flush()
    await flush()

    const second = await manager.start({ prompt: "more", parent_session_id: "parent-1", depth: 1, category: "unspecified-high" })

    // then: it must have been LAUNCHED, not merely reported as running. A leaked lease parks the
    // second task in the lane queue, and the queued path reports "running" too, so only the
    // presence of its own start on the fallback lane proves the lease was actually released.
    if (second.kind !== "started") throw new Error(`expected started, got ${JSON.stringify(second)}`)
    expect(second.status).toBe("running")
    expect(
      runner.startedSpecs.some((spec) => spec.taskId === second.task_id && spec.model === BUILTIN_MODEL.display),
    ).toBe(true)
    expect(store.load(first.task_id)?.status).toBe("completed")
  })
})

describe("a start-time fallback whose model lane is full (omo#9069)", () => {
  test("#given the fallback model's lane is full #when the refused start walks the chain #then the task reports pending with its queue position and launches once the lane frees", async () => {
    // given - one slot per model, and a task already holding the fallback model's slot
    const runner = new AdmissionRefusingRunner(new Set([PACKAGE_MODEL.display]))
    const { manager, store } = makeManager({
      planner: chainPlanner([BUILTIN_MODEL]),
      inProcess: runner,
      config: settings({ default_concurrency: 1, max_depth: 1 }),
    })
    const holder = await manager.start({ prompt: "hold", parent_session_id: "parent-1", depth: 1, model: BUILTIN_MODEL.display })
    if (holder.kind !== "started") throw new Error("expected the holder to start")

    // when
    const result = await manager.start({ prompt: "work", parent_session_id: "parent-1", depth: 1, category: "unspecified-high" })

    // then - not reported as running while no child exists
    if (result.kind !== "started") throw new Error(`expected started, got ${JSON.stringify(result)}`)
    expect(result.status).toBe("pending")
    expect(result.queue_position).toBe(1)
    const queued = store.load(result.task_id)
    expect(queued?.start_queued?.model).toBe(BUILTIN_MODEL.display)
    expect(runner.handles.has(result.task_id)).toBe(false)
    const eventLog = readFileSync(join(store.stateDir, "logs", `${result.task_id}.jsonl`), "utf8")
    expect(eventLog).toContain('"type":"task_start_queued"')

    // when - the holder finishes and frees the lane
    runner.handles.get(holder.task_id)?.settle({ status: "completed", finalResponse: "done" })
    await flush()
    await flush()

    // then
    expect(runner.handles.has(result.task_id)).toBe(true)
    expect(store.load(result.task_id)?.start_queued).toBeUndefined()
  })

  test("#given a starting task refused after the start window #when it falls back into a full lane and is later accepted #then task_started is recorded exactly once (#10402)", async () => {
    // given - the fallback model's only slot is held, and the first model answers after the window
    const runner = new LateRefusingRunner()
    const { manager, store } = makeManager({
      planner: chainPlanner([BUILTIN_MODEL]),
      inProcess: runner,
      config: settings({ default_concurrency: 1, max_depth: 1 }),
    })
    const holder = await manager.start({ prompt: "hold", parent_session_id: "parent-1", depth: 1, model: BUILTIN_MODEL.display })
    if (holder.kind !== "started") throw new Error("expected the holder to start")
    const result = await bounded(manager.start({ prompt: "work", parent_session_id: "parent-1", depth: 1, category: "unspecified-high" }))
    if (result.kind !== "starting") throw new Error(`expected starting, got ${JSON.stringify(result)}`)

    // when - the refusal walks the chain into the full lane, then the lane frees
    runner.refuse()
    await bounded(manager.whenLaunched?.(result.task_id) ?? Promise.resolve())
    expect(readEvents(store, result.task_id)).toContain("task_start_queued")
    const admitted = runner.admitted(result.task_id)
    runner.handles.get(holder.task_id)?.settle({ status: "completed", finalResponse: "done" })
    await bounded(admitted)
    const accepted = runner.handles.get(result.task_id)
    if (accepted === undefined) throw new Error("the queued fallback never launched")
    await bounded(accepted.waitForSubscription())

    // then
    expect(readEvents(store, result.task_id).filter((type) => type === "task_started")).toHaveLength(1)
  })
})
