import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"

import type { SenpiExtensionAPI } from "../../extension/types"
import { registrySnapshot } from "../memory/facts-runner.test-support"
import {
  ONBOARDING_SCAN_RPC_EVENT,
  ONBOARDING_SCAN_RPC_METHOD,
  createOnboardingScanComponent,
  loadOnboardingScanRuntime,
  type OnboardingScanEvent,
  type OnboardingScanRuntime,
} from "./scan-component"
import { encodeRecord, writeTranscript } from "./session-history/test-support"
import { fakeModel, tempRoot, UNDERSTAND_MODEL, type FakeTurn } from "./understand.test-support"
import {
  ONBOARDING_UNDERSTAND_RPC_EVENT,
  ONBOARDING_UNDERSTAND_RPC_METHOD,
  ONBOARDING_UNDERSTAND_SKIP_RPC_METHOD,
  ONBOARDING_UNDERSTAND_STOP_RPC_METHOD,
  type OnboardingUnderstandEvent,
} from "./understand-contract"

const EVENT_TIMEOUT_MS = 20_000
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

type Handler = (data: unknown) => unknown

async function profile() {
  const root = await tempRoot("omo-understand-rpc-")
  cleanups.push(root.cleanup)
  const home = join(root.path, "home")
  const codex = join(root.path, "codex")
  const workspace = join(root.path, "workspace")
  for (const [index, prompt] of ["Ship the feature with bun", "Fix the bun test"].entries()) {
    await writeTranscript({
      filePath: join(codex, "sessions", "2026", "10", "18", `rollout-${index}.jsonl`),
      mtimeMs: Date.now() - (index + 1) * 1_000,
      contents: [
        encodeRecord({ type: "session_meta", payload: { id: `codex-${index}`, cwd: workspace } }),
        encodeRecord({ type: "event_msg", payload: { type: "user_message", message: prompt } }),
      ].join("\n"),
    })
  }
  return {
    home,
    stateDir: join(root.path, "state"),
    environment: {
      home,
      env: { HOME: home },
      agentDir: join(home, ".omo", "agent"),
      stateDir: join(root.path, "state"),
      sessionHistory: { homes: [{ source: "codex" as const, homePath: codex }], omoSessionsRoots: [] },
    },
  }
}

function host(input: {
  readonly environment: Awaited<ReturnType<typeof profile>>["environment"]
  readonly turn: FakeTurn
  readonly withRegistry?: boolean
  readonly loadRuntime?: () => Promise<OnboardingScanRuntime>
}) {
  const handlers = new Map<string, Handler>()
  const sessionHandlers: Array<(payload: unknown, ctx?: unknown) => unknown> = []
  const scanEvents: OnboardingScanEvent[] = []
  const understandEvents: OnboardingUnderstandEvent[] = []
  const waiters: Array<() => void> = []
  const model = fakeModel(input.turn)
  const pi = {
    rpc: {
      emit(name: string, data: unknown) {
        if (name === ONBOARDING_SCAN_RPC_EVENT) scanEvents.push(data as OnboardingScanEvent)
        if (name === ONBOARDING_UNDERSTAND_RPC_EVENT) understandEvents.push(data as OnboardingUnderstandEvent)
        for (const waiter of waiters.splice(0)) waiter()
      },
      handle(name: string, handler: Handler) { handlers.set(name, handler) },
    },
    on(event: string, handler: (payload: unknown, ctx?: unknown) => unknown) {
      if (event === "session_start") sessionHandlers.push(handler)
    },
  } as unknown as SenpiExtensionAPI
  createOnboardingScanComponent({
    runtime: () => input.environment,
    understanding: { createRunner: model.createRunner },
    ...(input.loadRuntime === undefined ? {} : { loadRuntime: input.loadRuntime }),
  }).register(pi, {} as never)
  if (input.withRegistry !== false) for (const handler of sessionHandlers) handler({}, { modelRegistry: registrySnapshot() })

  const until = async (label: string, ready: () => boolean): Promise<void> => {
    const deadline = Date.now() + EVENT_TIMEOUT_MS
    while (!ready()) {
      if (Date.now() > deadline) throw new Error(`waited ${EVENT_TIMEOUT_MS}ms for ${label}, never fired`)
      await new Promise<void>((resolve) => {
        waiters.push(resolve)
        setTimeout(resolve, EVENT_TIMEOUT_MS).unref?.()
      })
    }
  }
  const call = async (method: string, request: unknown) => {
    const handler = handlers.get(method)
    if (handler === undefined) throw new Error(`${method} is not registered`)
    return await handler(request) as Record<string, unknown>
  }
  const scan = async (): Promise<string> => {
    const { scanId } = await call(ONBOARDING_SCAN_RPC_METHOD, {})
    await until(`scan ${String(scanId)} done`, () => scanEvents.some((event) => event.scanId === scanId && event.kind === "done"))
    return String(scanId)
  }
  const understandDone = async (understandId: string) => {
    await until(`understanding ${understandId} done`, () => understandEvents.some((event) => event.understandId === understandId && event.kind === "done"))
    return understandEvents.filter((event) => event.understandId === understandId)
  }
  return { call, scan, understandDone, starts: model.starts }
}

describe("omo.onboarding.understand RPC (#10480)", () => {
  test("#given no consent #when understanding is requested #then it is rejected and no model runs", async () => {
    // given
    const { environment } = await profile()
    const rpc = host({ environment, turn: async () => "completed" })
    const scanId = await rpc.scan()

    // when
    const missing = await rpc.call(ONBOARDING_UNDERSTAND_RPC_METHOD, { scanId, model: UNDERSTAND_MODEL })
    const refused = await rpc.call(ONBOARDING_UNDERSTAND_RPC_METHOD, { scanId, model: UNDERSTAND_MODEL, consent: false })

    // then
    expect(missing).toMatchObject({ kind: "invalid" })
    expect(refused).toMatchObject({ kind: "invalid" })
    expect(rpc.starts).toHaveLength(0)
  })

  test("#given a finished scan and consent #when understanding is requested #then the caller's model reads the scan's digests and returns candidates", async () => {
    // given
    const { environment } = await profile()
    const rpc = host({ environment, turn: async ({ record }) => {
      await record("The user tests with bun.")
      return "completed"
    } })
    const scanId = await rpc.scan()

    // when
    const response = await rpc.call(ONBOARDING_UNDERSTAND_RPC_METHOD, { scanId, model: UNDERSTAND_MODEL, consent: true })
    const events = await rpc.understandDone(String(response["understandId"]))

    // then
    expect(typeof response["understandId"]).toBe("string")
    expect(events.map((event) => event.kind)).toEqual(["step_started", "fact", "step_done", "done"])
    expect(events[0]?.step?.label).toBe("Read 2 recent sessions in workspace")
    expect(events.at(-1)?.candidates?.[0]?.sources).toEqual(["codex:codex-0", "codex:codex-1"])
    expect(rpc.starts.map((spec) => spec.model?.id)).toEqual(["mock-1"])
    expect(rpc.starts[0]?.prompt).toContain("Ship the feature with bun")
  })

  test("#given a scan id with no digests #when understanding is requested #then it is unavailable", async () => {
    // given
    const { environment } = await profile()
    const rpc = host({ environment, turn: async () => "completed" })

    // when
    const response = await rpc.call(ONBOARDING_UNDERSTAND_RPC_METHOD, { scanId: "never-scanned", model: UNDERSTAND_MODEL, consent: true })

    // then
    expect(response).toMatchObject({ kind: "unavailable" })
    expect(rpc.starts).toHaveLength(0)
  })

  test("#given the onboarding runtime fails to load #when understanding is requested #then it answers unavailable with the reason and no model runs", async () => {
    // given
    const { environment } = await profile()
    let loads = 0
    const rpc = host({
      environment,
      turn: async () => "completed",
      loadRuntime: async () => {
        loads += 1
        if (loads > 1) throw new Error("omo-onboarding-scan.js is missing")
        return await loadOnboardingScanRuntime()
      },
    })
    const scanId = await rpc.scan()

    // when
    const response = await rpc.call(ONBOARDING_UNDERSTAND_RPC_METHOD, { scanId, model: UNDERSTAND_MODEL, consent: true })

    // then
    expect(response).toEqual({ kind: "unavailable", reason: expect.stringContaining("omo-onboarding-scan.js is missing") })
    expect(rpc.starts).toHaveLength(0)
  })

  test("#given no session has started #when understanding is requested #then it is unavailable because no model registry exists", async () => {
    // given
    const { environment } = await profile()
    const rpc = host({ environment, turn: async () => "completed", withRegistry: false })
    const scanId = await rpc.scan()

    // when
    const response = await rpc.call(ONBOARDING_UNDERSTAND_RPC_METHOD, { scanId, model: UNDERSTAND_MODEL, consent: true })

    // then
    expect(response).toMatchObject({ kind: "unavailable" })
  })

  test("#given a running understanding #when skip and stop are called #then they reach the run and an unknown id is unavailable", async () => {
    // given
    const { environment } = await profile()
    let understandId = ""
    const controlled: Array<Record<string, unknown>> = []
    const rpc = host({ environment, turn: async () => {
      controlled.push(await rpc.call(ONBOARDING_UNDERSTAND_SKIP_RPC_METHOD, { understandId, project: "/elsewhere" }))
      controlled.push(await rpc.call(ONBOARDING_UNDERSTAND_STOP_RPC_METHOD, { understandId }))
      return "hang"
    } })
    const scanId = await rpc.scan()

    // when
    const response = await rpc.call(ONBOARDING_UNDERSTAND_RPC_METHOD, { scanId, model: UNDERSTAND_MODEL, consent: true })
    understandId = String(response["understandId"])
    const events = await rpc.understandDone(understandId)
    const unknown = await rpc.call(ONBOARDING_UNDERSTAND_STOP_RPC_METHOD, { understandId: "nope" })

    // then
    expect(controlled).toEqual([{ understandId, accepted: true }, { understandId, accepted: true }])
    expect(events.at(-1)).toMatchObject({ kind: "done", stopped: true })
    expect(unknown).toMatchObject({ kind: "unavailable" })
  })
})
