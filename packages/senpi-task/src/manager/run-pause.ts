import type { ChildPausePort, ResumedChildTurn, RunPauseOwner } from "../pause/ports"
import type { TaskRecordStore } from "../store"
import type { ManagedChildHandle } from "./child-handle"
import { TaskConcurrency, type ParkedLease } from "./concurrency"
import { PendingPauses } from "./pending-pauses"

export type ResumeTaskRequest = RunPauseOwner & {
  readonly resumeId: string
  readonly childSeqCutoff: number
}
export type ResumeTaskResult =
  | { readonly turnId: string }
  | { readonly otherHoldLive: true; readonly childSeq: number }

export type TaskPauseMethods = {
  pauseTask(taskId: string, owner: RunPauseOwner): Promise<{ readonly childSeq: number }>
  resumePausedTask(taskId: string, request: ResumeTaskRequest): Promise<ResumeTaskResult>
}

export function createTaskRunPause(ports: {
  readonly store: TaskRecordStore
  readonly concurrency: TaskConcurrency
  readonly child?: ChildPausePort
  readonly now: () => number
  liveHandle(taskId: string): ManagedChildHandle | undefined
  track(taskId: string, handle: ManagedChildHandle, model: string, epoch: number, turn: ResumedChildTurn): void
}) {
  const intents = new PendingPauses()
  const parked = new Map<string, ParkedLease>()
  const resumed = new Map<string, { readonly resumeId: string; readonly result: ResumeTaskResult }>()

  function park(taskId: string, epoch: number): void {
    const lease = ports.concurrency.park(taskId, epoch)
    if (lease !== undefined) parked.set(taskId, lease)
    intents.settle(taskId, epoch)
  }

  function childPort(): ChildPausePort {
    if (ports.child === undefined) throw new Error("child pause port is not installed")
    return ports.child
  }

  function live(taskId: string) {
    const record = ports.store.load(taskId)
    const handle = ports.liveHandle(taskId)
    if (record === null || record === undefined || handle === undefined) throw new Error(`paused child ${taskId} is not attached`)
    return { record, handle }
  }

  async function pauseTask(taskId: string, owner: RunPauseOwner): Promise<{ readonly childSeq: number }> {
    const port = childPort()
    const { record, handle } = live(taskId)
    const epoch = record.notification.run_epoch
    if (record.status !== "running" && record.status !== "paused") throw new Error(`cannot pause ${record.status} task`)
    const settled = record.status === "paused" ? undefined : intents.begin(taskId, epoch)
    resumed.delete(taskId)
    // Registration above MUST precede the child call: its abort can settle immediately.
    const ack = await port.pauseForRun(handle, owner)
    intents.acknowledge(taskId, epoch)
    if (settled !== undefined) await settled
    return ack
  }

  async function acquire(taskId: string): Promise<void> {
    const { record } = live(taskId)
    const epoch = record.notification.run_epoch
    const token = parked.get(taskId)
    if (token !== undefined) {
      await ports.concurrency.unpark(token)
      parked.delete(taskId)
      return
    }
    if (ports.concurrency.leaseState(taskId, epoch) === "held") return
    // Restart has no original token: acquire a new lease, never unpark a reconstructed object.
    const granted = Promise.withResolvers<void>()
    ports.concurrency.enqueue(record.model, taskId, epoch, () => granted.resolve())
    ports.concurrency.drain()
    await granted.promise
  }

  async function resumePausedTask(taskId: string, request: ResumeTaskRequest): Promise<ResumeTaskResult> {
    const previous = resumed.get(taskId)
    if (previous?.resumeId === request.resumeId) return previous.result
    const port = childPort()
    const { record, handle } = live(taskId)
    if (record.status !== "paused") throw new Error(`cannot resume ${record.status} task`)
    await acquire(taskId)
    const result = await port.resumeTurn(handle, request)
    if ("otherHoldLive" in result) {
      park(taskId, record.notification.run_epoch)
      return result
    }
    intents.clear(taskId)
    const unpaused = ports.store.transition(taskId, { type: "unpause", timestamp: new Date(ports.now()).toISOString() })
    if (!unpaused.applied) throw new Error("paused child changed while resuming")
    // The returned promise belongs to turnId even when already settled; never waitForOutcome here.
    ports.track(taskId, handle, record.model, record.notification.run_epoch, result)
    const receipt = { turnId: result.turnId }
    resumed.set(taskId, { resumeId: request.resumeId, result: receipt })
    return receipt
  }

  function forget(taskId: string): void {
    intents.clear(taskId)
    parked.delete(taskId)
    resumed.delete(taskId)
  }

  return { pauseTask, resumePausedTask, park, forget, settlement: (taskId: string, epoch: number) => intents.settlement(taskId, epoch) }
}
