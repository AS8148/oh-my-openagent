import type { ChildProcess } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { RpcProcessRunner } from "../runners/rpc-process"
import { spawnFakeChild } from "../runners/rpc/__fixtures__/spawn-fake"
import { stopFakeChild } from "../runners/rpc/__fixtures__/stop-fake-child"
import type { ResolvedModelRecord } from "../state"
import { createRpcManagedRunner } from "./runner"
import type { ChildPlanner } from "./types"
import { cleanupProjects, launchSettled, makeManager } from "./__fixtures__/manager-fakes"

const PRIMARY: ResolvedModelRecord = { provider: "openai", model_id: "gpt-5.6-sol", display: "openai/gpt-5.6-sol", source: "category" }
const SAME_PROVIDER: ResolvedModelRecord = { provider: "openai", model_id: "gpt-5.5", display: "openai/gpt-5.5", source: "category" }
const OTHER_PROVIDER: ResolvedModelRecord = { provider: "kimi-coding", model_id: "kimi-k3", display: "kimi-coding/kimi-k3", source: "category" }
const PARENT = "anthropic/claude-opus-5-5"

// The engine's typed prompt refusals (senpi `ModelNotReadyError` on the RPC wire): a provider with no
// stored key, and a stored login that could not be refreshed.
const MISSING = { error: "No API key found for openai.", errorCode: "provider_credentials_missing", errorData: { provider: "openai" } }
const EXPIRED = { error: "Authentication failed for \"kimi-coding\".", errorCode: "provider_credentials_expired", errorData: { provider: "kimi-coding" } }

const spawned: ChildProcess[] = []

afterEach(async () => {
  while (spawned.length > 0) {
    const child = spawned.pop()
    if (child) await stopFakeChild(child)
  }
  cleanupProjects()
})

const chainPlanner: ChildPlanner = () => ({
  kind: "resolved",
  plan: { model: PRIMARY.display, resolved_model: PRIMARY, category: "unspecified-high", fallback_models: [SAME_PROVIDER, OTHER_PROVIDER] },
})

// A real process runner over the scripted fake child: each launched model's child refuses its first prompt
// with the payload `refusals` names for that model, and every other model's child serves the turn.
function refusingProcessRunner(refusals: Readonly<Record<string, object>>) {
  const launched: string[] = []
  const runner = new RpcProcessRunner({
    modelAdmission: async () => {},
    buildSpawn: (spec) => {
      launched.push(spec.model ?? "")
      const refusal = refusals[spec.model ?? ""]
      return {
        command: process.execPath,
        args: [],
        cwd: spec.cwd,
        env: { ...process.env, ...(refusal === undefined ? {} : { FAKE_PROMPT_REFUSAL: JSON.stringify(refusal) }) },
      }
    },
    spawnChild: (descriptor) => {
      const child = spawnFakeChild(descriptor.env)
      spawned.push(child)
      return child
    },
  })
  return { runner, launched }
}

function events(stateDir: string, taskId: string): Array<{ type: string; payload: Record<string, unknown> }> {
  return readFileSync(join(stateDir, "logs", `${taskId}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
}

describe("a process child whose prompt start is refused for missing provider credentials (#10806)", () => {
  test("#given the primary provider has no key and the next provider's login expired #when the task starts #then it skips the same-provider rung, hops to the next provider, then lands on the parent rung", async () => {
    // given
    const { runner, launched } = refusingProcessRunner({ [PRIMARY.display]: MISSING, [OTHER_PROVIDER.display]: EXPIRED })
    const { manager, store } = makeManager({ planner: chainPlanner, process: createRpcManagedRunner(runner) })

    // when
    const result = await manager.start({
      prompt: "work", parent_session_id: "parent-1", depth: 1, category: "unspecified-high", execution_mode: "process", parent_model: PARENT,
    })
    await launchSettled(manager, result)

    // then
    if (result.kind !== "started") throw new Error(`expected started, got ${JSON.stringify(result)}`)
    expect(launched).toEqual([PRIMARY.display, OTHER_PROVIDER.display, PARENT])
    const fallbacks = events(store.stateDir, result.task_id).filter((event) => event.type === "task_model_fallback")
    expect(fallbacks.map((event) => [event.payload.from_model, event.payload.to_model])).toEqual([
      [PRIMARY.display, OTHER_PROVIDER.display],
      [OTHER_PROVIDER.display, PARENT],
    ])
    expect(fallbacks.map((event) => [event.payload.cause_class, event.payload.cause_code, event.payload.provider])).toEqual([
      ["credentials_missing", "provider_credentials_missing", "openai"],
      ["credentials_missing", "provider_credentials_expired", "kimi-coding"],
    ])
    const record = store.load(result.task_id)
    expect(record?.model).toBe(PARENT)
    expect(record?.fallback_models ?? []).toEqual([])
    expect(record?.parent_model_fallback?.reason).toBe("not_signed_in")
    expect(record?.parent_model_fallback?.from_model).toBe(OTHER_PROVIDER.display)
    await runner.settleTeardowns()
  })

  test("#given a prompt refusal that carries no error code #when the task starts #then it fails as a host refusal without walking the chain", async () => {
    // given: an engine that predates the typed refusal answers with text only
    const { runner, launched } = refusingProcessRunner({ [PRIMARY.display]: { error: MISSING.error } })
    const { manager, store } = makeManager({ planner: chainPlanner, process: createRpcManagedRunner(runner) })

    // when
    const result = await manager.start({
      prompt: "work", parent_session_id: "parent-1", depth: 1, category: "unspecified-high", execution_mode: "process", parent_model: PARENT,
    })

    // then
    expect(["start_failed", "error"]).toContain(await launchSettled(manager, result))
    if (result.kind !== "started" && result.kind !== "start_failed") throw new Error(`unexpected ${JSON.stringify(result)}`)
    expect(launched).toEqual([PRIMARY.display])
    const log = events(store.stateDir, result.task_id)
    expect(log.some((event) => event.type === "task_model_fallback")).toBe(false)
    const failed = log.find((event) => event.type === "task_start_failed")
    expect(failed?.payload).toMatchObject({ failure_kind: "child-prompt-failed", cause_class: "host_refused" })
    expect(failed?.payload).not.toHaveProperty("cause_code")
    expect(store.load(result.task_id)?.model).toBe(PRIMARY.display)
    await runner.settleTeardowns()
  })
})
