import { AdmissionBarrier, type AdmissionTicket, type ResumeCredential } from "../pause/admission-barrier"
import type { RunRef } from "../pause/ports"
import { createTaskId } from "../state/id"
import type { ManagerStartSpec } from "./types"

export type HeldStart = {
  readonly kind: "held"
  readonly pauseSeq: number
  readonly root_session_id: string
  readonly task_id: string
}

const heldErrors = new WeakSet<object>()

export class AdmissionHeld extends Error {
  constructor(readonly result: HeldStart) {
    super("run admission is held")
    heldErrors.add(this)
  }
}

export function isAdmissionHeld(value: unknown): value is AdmissionHeld {
  return ((typeof value === "object" && value !== null) || typeof value === "function") && heldErrors.has(value)
}

export type StartAdmission = AdmissionTicket & {
  readonly taskId: string
  readonly rootSessionId: string
  readonly runRef: RunRef
  assertOpen(): void
  transfer(): void
  hold(): HeldStart
  bind(taskId: string): void
}

export function createStartAdmissions(barrier: AdmissionBarrier, held?: (result: HeldStart, spec: ManagerStartSpec) => void, now = Date.now) {
  async function run<T>(
    spec: ManagerStartSpec,
    runRef: RunRef | undefined,
    body: (admitted: ManagerStartSpec) => Promise<T>,
    credential?: ResumeCredential,
  ): Promise<T | HeldStart> {
    let taskId: string = createTaskId(now())
    const rootSessionId = spec.root_session_id ?? spec.parent_session_id
    const participant = { key: taskId, runRef: runRef ?? { kind: "task" as const, id: taskId } }
    const entered = barrier.enter(rootSessionId, participant, credential)
    const result = (pauseSeq: number): HeldStart => ({ kind: "held", pauseSeq, task_id: taskId, root_session_id: rootSessionId })
    if (entered.kind === "held") {
      const custody = result(entered.pauseSeq)
      held?.(custody, spec)
      return custody
    }
    let transferred = false
    const scope: StartAdmission = {
      ...entered.ticket, get taskId() { return taskId }, rootSessionId,
      get runRef() { return participant.runRef },
      bind: id => {
        taskId = id
        if (participant.runRef.kind === "task") participant.runRef = { kind: "task", id }
        entered.ticket.update({ key: id, runRef: participant.runRef })
      },
      transfer: () => { transferred = true },
      hold: () => {
        const check = entered.ticket.check()
        if (check.kind !== "held") throw new Error("open admission cannot enter held custody")
        const custody = result(check.pauseSeq)
        held?.(custody, spec)
        return custody
      },
      assertOpen: () => {
        const check = entered.ticket.check()
        if (check.kind === "held") throw new AdmissionHeld(result(check.pauseSeq))
      },
    }
    try { return await body({ ...spec, admission: scope }) }
    catch (error) {
      if (!isAdmissionHeld(error)) throw error
      held?.(error.result, spec)
      return error.result
    } finally {
      if (!transferred) scope.leave()
    }
  }
  return { run }
}
