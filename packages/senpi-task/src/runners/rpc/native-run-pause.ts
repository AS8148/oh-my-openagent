import { NativePauseUnavailableError, type NativeRunPause } from "../../pause/native-child-pause"
import type { RunnerOutcome } from "../in-process/child-handle"
import { createTaskParentControl, TaskParentControlError } from "../task-parent-control"
import type { RpcProtocolClient } from "./protocol-client"

const TASK_PARENT_WIDTH = 80

/**
 * The RPC child's run hold over its own connection, declared `task_parent` once. A Resume turn the
 * engine starts is CLAIMED before the command goes out, so its agent_start re-arms this handle's turn
 * tracking without announcing a self-resumed run (which would reopen and complete the record twice).
 */
export function createRpcRunPause(input: {
  readonly taskId: string
  readonly client: Pick<RpcProtocolClient, "sendTaskParent">
  claimNextTurn(): () => void
  currentOutcome(): Promise<RunnerOutcome>
}): NativeRunPause {
  const control = createTaskParentControl({ width: TASK_PARENT_WIDTH, send: command => input.client.sendTaskParent(command) })
  const unsupported = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      if (error instanceof TaskParentControlError && error.code === "unsupported") throw new NativePauseUnavailableError(input.taskId)
      throw error
    }
  }
  return {
    pauseForRun: owner => unsupported(() => control.pauseForRun(owner)),
    async resumeForRun(request) {
      const releaseClaim = input.claimNextTurn()
      try {
        const receipt = await unsupported(() => control.resumeForRun(request))
        if (!receipt.released) {
          releaseClaim()
          return receipt
        }
        if (receipt.otherHoldLive === true || receipt.turnId === undefined) {
          releaseClaim()
          return { released: true, otherHoldLive: true }
        }
        // The engine answers after the turn's agent_start, which this connection already delivered.
        return { released: true, turnId: receipt.turnId, outcome: input.currentOutcome() }
      } catch (error) {
        releaseClaim()
        throw error
      }
    },
    holdInput: (parentSessionId, held) => unsupported(() => control.holdInput(parentSessionId, held)),
  }
}
