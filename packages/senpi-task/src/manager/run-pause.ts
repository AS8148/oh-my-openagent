import type { ChildPausePort, EngineHoldInputResult, EngineInheritReceipt, ResumedChildTurn, RunPauseOwner } from "../pause/ports"
import type { TaskRecordStore } from "../store"
import type { ManagedChildHandle } from "./child-handle"
import type { TaskConcurrency } from "./concurrency"
import { ResumeCapacity, type ResumeAllocation } from "./resume-capacity"
import { PendingPauses } from "./pending-pauses"
import type { AdmissionBarrier, ResumeCredential } from "../pause/admission-barrier"
import { buildRevived } from "../steering/engine-policy"

export type ResumeTaskRequest = RunPauseOwner & {
  readonly resumeCredential?: ResumeCredential
  readonly allocation?: ResumeAllocation
  readonly resumeId: string
  readonly childSeqCutoff: number
}

export class RunPauseAdmissionHeld extends Error {
  readonly code = "run_admission_held"
  constructor() { super("the run Resume was superseded by a hold") }
}
export type ResumeTaskResult =
  | { readonly turnId: string }
  | { readonly otherHoldLive: true; readonly childSeq?: number }

export type TaskPauseMethods = {
  pauseTask(taskId: string, owner: RunPauseOwner): Promise<EngineInheritReceipt>
  resumePausedTask(taskId: string, request: ResumeTaskRequest): Promise<ResumeTaskResult>
  holdTaskInput(taskId: string, input: HeldTaskInput): Promise<EngineHoldInputResult>
}

export type HeldTaskInput = { readonly inputId: string; readonly revision: number; readonly text: string }

export function createTaskRunPause(ports: {
  readonly store: TaskRecordStore
  readonly concurrency: TaskConcurrency
  readonly child?: ChildPausePort
  readonly barrier?: AdmissionBarrier
  readonly now: () => number
  liveHandle(taskId: string): ManagedChildHandle | undefined
  track(taskId: string, handle: ManagedChildHandle, model: string, epoch: number, turn: ResumedChildTurn): void
}) {
  const intents = new PendingPauses()
  const capacity = new ResumeCapacity(ports.concurrency)
  const resumed = new Map<string, { readonly resumeId: string; readonly result: ResumeTaskResult }>()
  const attempts = new Map<string, { readonly resumeId: string; readonly cancel: AbortController }>()
  const owners = new Map<string, RunPauseOwner>()

  function park(taskId: string, epoch: number): void {
    capacity.park(taskId, epoch)
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

  async function pauseTask(taskId: string, owner: RunPauseOwner): Promise<EngineInheritReceipt> {
    const port = childPort()
    const { record, handle } = live(taskId)
    const epoch = record.notification.run_epoch
    if (record.status !== "running" && record.status !== "paused") throw new Error(`cannot pause ${record.status} task`)
    const settled = record.status === "paused" ? undefined : intents.begin(taskId, epoch)
    const resuming = attempts.get(taskId)
    resumed.delete(taskId)
    // Registration above MUST precede the child call: its abort can settle immediately.
    let ack: EngineInheritReceipt
    try {
      ack = await port.pauseForRun(handle, owner)
    } catch (error) {
      if (settled !== undefined) intents.clear(taskId)
      throw error
    }
    if ("refused" in ack) {
      intents.clear(taskId)
      return ack
    }
    owners.set(taskId, owner)
    if (attempts.get(taskId) === resuming) {
      attempts.delete(taskId)
      resuming?.cancel.abort()
      if (record.status === "paused") park(taskId, epoch)
    }
    intents.acknowledge(taskId, epoch)
    if (settled !== undefined) await settled
    return ack
  }

  async function resumePausedTask(taskId: string, request: ResumeTaskRequest): Promise<ResumeTaskResult> {
    const previous = resumed.get(taskId)
    if (previous?.resumeId === request.resumeId) return previous.result
    const port = childPort()
    const { record, handle } = live(taskId)
    if (record.status !== "paused") throw new Error(`cannot resume ${record.status} task`)
    const entered = ports.barrier?.enter(record.root_session_id ?? record.parent_session_id,
      { key: taskId, runRef: request.runRef }, request.resumeCredential)
    if (entered?.kind === "held") throw new RunPauseAdmissionHeld()
    const attempt = { resumeId: request.resumeId, cancel: new AbortController() }
    attempts.set(taskId, attempt)
    const assertCurrent = (): void => {
      if (attempts.get(taskId) !== attempt) throw new RunPauseAdmissionHeld()
      if (entered?.ticket.check().kind === "held") {
        park(taskId, record.notification.run_epoch)
        throw new RunPauseAdmissionHeld()
      }
      const current = ports.store.load(taskId)
      if (current?.status !== "paused" || current.notification.run_epoch !== record.notification.run_epoch || ports.liveHandle(taskId) !== handle) {
        park(taskId, record.notification.run_epoch)
        throw new Error("paused task changed while resuming")
      }
    }
    try {
      const acquired = await capacity.acquire(record, attempt.cancel.signal, request.allocation)
      assertCurrent()
      if (!acquired) throw new RunPauseAdmissionHeld()
      const result = await port.resumeTurn(handle, request)
      assertCurrent()
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
    } finally {
      entered?.ticket.leave()
    }
  }

  // Guidance names the parent that paused this child; the child engine refuses any other parent.
  async function holdTaskInput(taskId: string, input: HeldTaskInput): Promise<EngineHoldInputResult> {
    const port = childPort()
    const { record, handle } = live(taskId)
    if (record.status !== "paused") throw new Error(`cannot hold input for ${record.status} task`)
    const owner = owners.get(taskId)
    if (owner === undefined) throw new Error(`paused child ${taskId} has no run owner in this process`)
    return port.holdInput(handle, input, { parentSessionId: owner.parentSessionId })
  }

  // An idle resident child has no turn to abort: its next run is opened paused under the run's
  // owner (a fresh epoch, as a revive would), so the run's Resume starts that turn.
  async function joinIdlePause(taskId: string, owner: RunPauseOwner): Promise<EngineInheritReceipt> {
    const port = childPort()
    const { record, handle } = live(taskId)
    if (record.status !== "completed" && record.status !== "error" && record.status !== "interrupted") {
      throw new Error(`cannot join an idle pause from ${record.status}`)
    }
    const ack = await port.pauseForRun(handle, owner)
    if ("refused" in ack) return ack
    const timestamp = new Date(ports.now()).toISOString()
    let opened = false
    ports.store.mutate(taskId, fresh => {
      if (fresh.status !== record.status || fresh.notification.run_epoch !== record.notification.run_epoch) return fresh
      opened = true
      return buildRevived(fresh, timestamp)
    })
    if (!opened || !ports.store.transition(taskId, { type: "pause", timestamp }).applied) {
      throw new Error(`idle child ${taskId} changed while joining the pause`)
    }
    owners.set(taskId, owner)
    return ack
  }

  function forget(taskId: string): void {
    owners.delete(taskId)
    intents.clear(taskId)
    const attempt = attempts.get(taskId)
    attempts.delete(taskId)
    attempt?.cancel.abort()
    capacity.forget(taskId)
    resumed.delete(taskId)
  }

  return { pauseTask, resumePausedTask, holdTaskInput, joinIdlePause, park, forget, settlement: (taskId: string, epoch: number) => intents.settlement(taskId, epoch) }
}
