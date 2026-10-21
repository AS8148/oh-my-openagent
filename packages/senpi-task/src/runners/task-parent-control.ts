import type { EngineResumeReceipt, RunPauseOwner } from "../pause/ports"

export type TaskParentCommand =
  | { readonly type: "set_client_info"; readonly width: number; readonly capabilities: readonly ["task_parent"] }
  | ({ readonly type: "pause_for_run" } & RunPauseOwner)
  | {
    readonly type: "resume_for_run"; readonly parentSessionId: string; readonly parentPauseSeq: number
    readonly resumeId: string; readonly childSeqCutoff: number
  }

export type TaskParentWire = {
  readonly width: number
  send(command: TaskParentCommand): Promise<
    { readonly success: true; readonly data?: unknown } | { readonly success: false; readonly error: string }>
}

export class TaskParentControlError extends Error {
  constructor(readonly code: "task_parent_required" | "request_rejected" | "protocol_error") {
    super(code)
  }
}

const identified = new WeakMap<TaskParentWire, Promise<void>>()

export function createTaskParentControl(wire: TaskParentWire) {
  function identify(): Promise<void> {
    let ready = identified.get(wire)
    if (ready === undefined) {
      ready = wire.send({ type: "set_client_info", width: wire.width, capabilities: ["task_parent"] }).then(response => {
        if (!response.success) throw rejection(response.error)
      })
      identified.set(wire, ready)
    }
    return ready
  }

  return {
    async pauseForRun(owner: RunPauseOwner): Promise<{ readonly childSeq: number } | { readonly refused: "wrong_parent" }> {
      await identify()
      const response = await wire.send({ type: "pause_for_run", ...owner })
      if (!response.success) {
        if (response.error.startsWith("wrong_parent:")) return { refused: "wrong_parent" }
        throw rejection(response.error)
      }
      const data = response.data
      if (!isRecord(data) || data.held !== true || typeof data.childSeq !== "number"
        || !Number.isSafeInteger(data.childSeq) || data.childSeq < 0) throw new TaskParentControlError("protocol_error")
      return { childSeq: data.childSeq }
    },
    async resumeForRun(request: {
      readonly parentSessionId: string; readonly parentPauseSeq: number; readonly resumeId: string; readonly childSeqCutoff: number
    }): Promise<EngineResumeReceipt> {
      await identify()
      const response = await wire.send({
        type: "resume_for_run", parentSessionId: request.parentSessionId, parentPauseSeq: request.parentPauseSeq,
        resumeId: request.resumeId, childSeqCutoff: request.childSeqCutoff,
      })
      if (!response.success) {
        if (response.error.startsWith("wrong_parent:")) return { released: false, reason: "wrong_parent" }
        throw rejection(response.error)
      }
      const data = response.data
      if (!isRecord(data)) throw new TaskParentControlError("protocol_error")
      if (data.released === false && (data.reason === "stale" || data.reason === "not_held")) {
        return { released: false, reason: data.reason }
      }
      if (data.released !== true || (data.otherHoldLive !== undefined && typeof data.otherHoldLive !== "boolean")
        || (data.turnId !== undefined && typeof data.turnId !== "string")) throw new TaskParentControlError("protocol_error")
      return {
        released: true,
        ...(data.otherHoldLive === undefined ? {} : { otherHoldLive: data.otherHoldLive }),
        ...(data.turnId === undefined ? {} : { turnId: data.turnId }),
      }
    },
  }
}

function rejection(message: string): TaskParentControlError {
  return new TaskParentControlError(message.startsWith("task_parent_required:") ? "task_parent_required" : "request_rejected")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
