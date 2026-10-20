import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { HOST_CHILD_MODEL, startHostWorld, type ParentSession } from "./rpc-host/__fixtures__/host-world"
import type { FakeHost } from "./rpc-host/__fixtures__/fake-host"
import { runTaskSend } from "../tools/control/send"
import { cleanupSteering, makeHarness } from "../steering/__fixtures__/steering-fakes"
import { adaptRpcHandle } from "../manager/child-handle"
import { childSpec, hostRunnerHarness } from "./rpc-host.test-support"
import { HostSessionClient } from "./rpc-host/session-client"
import { RpcRequestTimeout } from "./rpc/errors"

afterEach(cleanupSteering)

const INPUT_TYPES = ["prompt", "steer", "follow_up"]

// task_send can return before the host records the input: a send accepted while the first launch is
// still being admitted, or while the launch's drain runs, is queued and delivered by that drain
// (#10042, #9861). The test therefore waits for the host to record every input (#10318).
for (const launch of ["admitted", "held"] as const) {
  test(`#given a daemon task whose launch is ${launch} #when it receives two messages #then every parsed input carries the durable increasing identity`, async () => {
    const world = await startHostWorld({ transcripts: true })
    const parent = world.connect("parent")
    try {
      const taskId = launch === "admitted"
        ? await sendAfterAdmission(parent)
        : await sendDuringHeldLaunch(world.host, parent)
      await bounded(inputsRecorded(world.host, 3))
      const inputs = world.host.commands.filter(command => INPUT_TYPES.includes(command.type))
      expect(inputs.map(command => command.payload.clientMessageId)).toEqual([
        `${taskId}:0:1`, `${taskId}:0:2`, `${taskId}:0:3`,
      ])
      expect(parent.store.load(taskId)?.host_session?.effect_seq).toBe(3)
    } finally {
      await world.cleanup()
    }
  })
}

async function sendAfterAdmission(parent: ParentSession): Promise<string> {
  await parent.startChildren(1)
  const record = parent.records()[0]
  if (record === undefined) throw new Error("task did not start")
  await sendTwo(parent, record.task_id)
  return record.task_id
}

/** Holds the first prompt's reply, so both sends are queued behind the launch, then lets it finish. */
async function sendDuringHeldLaunch(host: FakeHost, parent: ParentSession): Promise<string> {
  const release = host.holdReply("prompt")
  const prompted = host.waitForCommand("prompt")
  const started = await parent.manager.start({
    prompt: "host child parent #0", parent_session_id: "parent", depth: 1, execution_mode: "process", model: HOST_CHILD_MODEL,
  })
  if (started.kind !== "started" || started.starting !== true) throw new Error(`launch was not held: ${started.kind}`)
  await bounded(prompted)
  expect(await sendTwo(parent, started.task_id)).toEqual(["queued", "queued"])
  release()
  await bounded(parent.manager.whenLaunched?.(started.task_id) ?? Promise.resolve())
  return started.task_id
}

async function sendTwo(parent: ParentSession, taskId: string): Promise<readonly string[]> {
  const first = await runTaskSend(parent.manager, { to: taskId, message: "first" }, "parent")
  const second = await runTaskSend(parent.manager, { to: taskId, message: "second" }, "parent")
  return [first.details.kind, second.details.kind]
}

/** Resolves once the host has recorded `count` inputs; each check and its subscription share one tick. */
async function inputsRecorded(host: FakeHost, count: number): Promise<void> {
  while (host.commands.filter(command => INPUT_TYPES.includes(command.type)).length < count) {
    await Promise.race(INPUT_TYPES.map(type => host.waitForCommand(type)))
  }
}

for (const conflict of [false, true]) {
  test(`#given a withheld steer ack #when the same-id retry ${conflict ? "conflicts" : "replays"} #then ${conflict ? "no delivery is reported" : "the host admits it once"}`, async () => {
    const hostHarness = hostRunnerHarness()
    const h = makeHarness()
    const record = h.seedRecord()
    h.store.transition(record.task_id, { type: "start", timestamp: new Date().toISOString() })
    const host = await hostHarness.fakeHost({ transcripts: true })
    let timedOut = false
    class DeadlineClient extends HostSessionClient {
      override async send(command: Parameters<HostSessionClient["send"]>[0]): Promise<void> {
        if (command.type !== "steer" || timedOut) return super.send(command)
        timedOut = true
        host.withholdReply("steer")
        const received = host.waitForCommand("steer")
        void super.send(command).catch(() => undefined)
        await bounded(received)
        throw new RpcRequestTimeout("steer", 30_000)
      }
    }
    const runner = hostHarness.runnerOver(host, {
      storeDir: h.store.stateDir,
      createClient: socketPath => new DeadlineClient({ socketPath, ports: { probeProtocolInfo: () => host.probeProtocolInfo() } }),
    })
    const handle = await runner.start(childSpec({ task_id: record.task_id, taskStoreDir: h.store.stateDir,
      state_dir: join(h.store.stateDir, "children", record.task_id) }))
    h.setLive(record.task_id, adaptRpcHandle(handle))
    try {
      const outcome = await h.engine.sendToTask({ idOrName: record.task_id, message: "once", deliverAs: "steer" })
      expect(outcome.kind).toBe("uncertain")
      const first = host.commands.find(command => command.type === "steer")
      if (first === undefined) throw new Error("steer never arrived")
      const session = host.sessions()[0]
      if (session === undefined) throw new Error("host session is missing")
      if (conflict) host.admissions.rebind(session.sessionPath, { ...first.payload, message: "different" })
      const second = host.waitForCommand("steer")
      host.allowReply("steer")
      await bounded(second)
      await handle.reconcileInputs?.()
      const sends = host.commands.filter(command => command.type === "steer")
      expect(sends).toHaveLength(2)
      expect(sends.map(command => ({ id: command.payload.clientMessageId, text: command.payload.message })))
        .toEqual([{ id: first.payload.clientMessageId, text: "once" }, { id: first.payload.clientMessageId, text: "once" }])
      expect(host.admissions.count()).toBe(2) // initial prompt plus one steer
      const events = readFileSync(join(h.store.stateDir, "logs", `${record.task_id}.jsonl`), "utf8")
        .trim().split("\n").map(line => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
      expect(events.filter(event => event.type === "effect_uncertain")).toHaveLength(1)
      expect(events.filter(event => event.type === "steered")).toHaveLength(conflict ? 0 : 1)
      if (conflict) expect(events.find(event => event.type === "effect_failed")?.payload).toMatchObject({
        reason: "effect_id_conflict", action: "send the message again",
      })
      expect(h.store.load(record.task_id)?.uncertain_inputs).toBeUndefined()
    } finally {
      await handle.dispose()
      await hostHarness.release()
    }
  })
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("host input did not arrive")), 5_000)
  })]) } finally { clearTimeout(timer) }
}

