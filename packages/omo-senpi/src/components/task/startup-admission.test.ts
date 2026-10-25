import { afterEach, expect, test } from "bun:test"
import { loadOmoConfig } from "@oh-my-opencode/omo-config-core"
import { createTaskLifecycle } from "@oh-my-opencode/senpi-task"
import { hostLifecycleDeps, hostSession, hostSessionRecordInput } from "../../../../senpi-task/src/lifecycle/__fixtures__/host-session-fakes"
import { cleanupProjects, seedRecord, tempStore } from "../../../../senpi-task/src/lifecycle/__fixtures__/lifecycle-fakes"
import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import { composeTaskEngine } from "./engine"
import { wireEventBridge } from "./event-bridge"
import { createSessionTransitionBridge } from "./session-transition-bridge"

afterEach(cleanupProjects)

test("session admission and RPC attachment finish while a host never answers", async () => {
  const store = tempStore()
  seedRecord(store, {
    ...hostSessionRecordInput("st_10056001", hostSession("st_10056001")),
    status: "running", host_pid: 1111,
  })
  const entered = Promise.withResolvers<void>()
  const probe = Promise.withResolvers<boolean>()
  const fixture = hostLifecycleDeps({ store, hostPid: 2222 })
  const lifecycle = createTaskLifecycle({
    ...fixture.deps,
    hostSessionProbe: {
      ...fixture.deps.hostSessionProbe!,
      daemonAlive: () => { entered.resolve(); return probe.promise },
    },
  })
  const pi = new FakeExtensionAPI()
  pi.rpc = { emit: (name, data) => { pi.rpcEvents.push({ name, data }) } }
  const cwd = store.stateDir
  const base = composeTaskEngine({ pi, cwd, omoConfig: loadOmoConfig({ cwd }).config, sharedParentTools: () => [] })
  base.lifecycle.dispose?.()
  const finished = Promise.withResolvers<void>()
  const engine = {
    ...base,
    lifecycle: {
      ...lifecycle,
      reconcileOnSessionStart: (id?: string, signal?: AbortSignal) => lifecycle.reconcileOnSessionStart(id, signal).finally(finished.resolve),
    },
  }
  wireEventBridge(pi, {
    logger: { info() {}, warn() {}, error() {} }, config: { getFlag: () => false }, getCapturedTools: () => [],
  }, engine, { scheduleSync() {}, syncNow() {}, observeRecord() {}, dispose() {} },
  createSessionTransitionBridge({ runtime: engine.runtime, notifier: engine.notifier }), {
    reconcileTeamMailbox: async () => {},
    leadPollers: { tick: async () => {}, shutdown() {} },
    resumptionChannels: { emitSessionStart: async () => {}, emitShutdown: async () => {} },
  })
  // RPC attachment is observable through the real task bridge; admission itself must settle
  // before the probe is released, with the test deadline only serving as a deadlock watchdog.
  const start = pi.dispatch("session_start", {}, { sessionManager: { getSessionId: () => "parent-1" } })
  try {
    await entered.promise
    expect(await Promise.race([
      start.then(() => "admitted"),
      new Promise<string>(resolve => setImmediate(() => resolve("blocked"))),
    ])).toBe("admitted")
    expect(pi.rpcEvents.some(event => event.name === "omo.task.updated")).toBe(true)
  } finally {
    lifecycle.dispose?.()
    probe.resolve(false)
    await start
    await finished.promise
  }
}, 1_000)
