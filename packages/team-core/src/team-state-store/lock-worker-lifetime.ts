import { randomUUID } from "node:crypto"
import { BroadcastChannel, parentPort, threadId, type Worker } from "node:worker_threads"
import { z } from "zod"

const Registration = z.object({ kind: z.literal("omo-team-lock-register-v1"), incarnation: z.string() })
const Message = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("query"), id: z.string(), incarnation: z.string(), record: z.string() }),
  z.object({ kind: z.literal("answer"), id: z.string(), released: z.boolean() }),
  z.object({ kind: z.literal("register"), threadId: z.number() }),
])
type LifetimeState = {
  readonly incarnation: string
  readonly records: Map<string, "held" | "released">
  readonly exited: Set<string>
  readonly observed: WeakSet<Worker>
  readonly pending: Map<string, (released: boolean) => void>
  readonly channel: BroadcastChannel
  installed: boolean
}

declare global {
  var __omoTeamLockLifetimeV1: LifetimeState | undefined
}

function createState(): LifetimeState {
  const channel = new BroadcastChannel(`omo-team-lock-lifetime-v1-${process.pid}`)
  channel.unref()
  const state: LifetimeState = {
    incarnation: randomUUID(),
    records: new Map(),
    exited: new Set(),
    observed: new WeakSet(),
    pending: new Map(),
    channel,
    installed: false,
  }
  channel.onmessage = (event) => {
    const parsed = Message.safeParse(event.data)
    if (!parsed.success) return
    const message = parsed.data
    switch (message.kind) {
      case "register":
        if (message.threadId === threadId) registerIncarnation()
        return
      case "answer":
        state.pending.get(message.id)?.(message.released)
        return
      case "query": {
        const status = message.incarnation === state.incarnation ? state.records.get(message.record) : undefined
        if (status !== undefined || state.exited.has(message.incarnation)) {
          channel.postMessage({
            kind: "answer",
            id: message.id,
            released: status === "released" || state.exited.has(message.incarnation),
          })
        }
        return
      }
    }
  }
  return state
}

const state = globalThis.__omoTeamLockLifetimeV1 ??= createState()
export const lockOwnerInstanceId = state.incarnation

/** Bind registrations and exit evidence to this exact Worker, never its reusable routing IDs. */
export function observeLockWorker(worker: Worker): void {
  attachWorker(worker)
  // A late observer may have missed the initial registration. Attach listeners before asking.
  state.channel.postMessage({ kind: "register", threadId: worker.threadId })
}

function attachWorker(worker: Worker): void {
  if (state.observed.has(worker)) return
  state.observed.add(worker)
  const incarnations = new Set<string>()
  let exited = false
  worker.on("message", (message: unknown) => {
    const parsed = Registration.safeParse(message)
    if (!parsed.success) return
    incarnations.add(parsed.data.incarnation)
    if (exited) state.exited.add(parsed.data.incarnation)
  })
  worker.once("exit", () => {
    exited = true
    for (const incarnation of incarnations) state.exited.add(incarnation)
  })
}

/** Install before creating workers; late-loaded hosts can observe an existing handle explicitly. */
export function installLockWorkerObserver(): void {
  if (state.installed) return
  state.installed = true
  process.on("worker", attachWorker)
  registerIncarnation()
}

function registerIncarnation(): void {
  parentPort?.postMessage({ kind: "omo-team-lock-register-v1", incarnation: state.incarnation })
}

installLockWorkerObserver()

export function markLockRecordHeld(record: string): void {
  state.records.set(record, "held")
}

export function markLockRecordReleased(record: string): void {
  if (state.records.has(record)) state.records.set(record, "released")
}

export function forgetLockRecord(record: string): void {
  state.records.delete(record)
}

export async function isWorkerLockReleased(incarnation: string, record: string): Promise<boolean> {
  if (state.exited.has(incarnation)) return true
  if (incarnation === state.incarnation) return state.records.get(record) === "released"
  const id = randomUUID()
  return await new Promise<boolean>((resolve) => {
    const finish = (released: boolean) => {
      clearTimeout(timer)
      state.pending.delete(id)
      resolve(released)
    }
    // A stalled or unobserved host is unknown. Elapsed time never certifies worker death.
    const timer = setTimeout(() => finish(false), 250)
    state.pending.set(id, finish)
    state.channel.postMessage({ kind: "query", id, incarnation, record })
  })
}
