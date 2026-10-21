import { cancelPausedDagNode } from "../../../../senpi-task/src/dag/paused-controls"
import { DagNodeControlError } from "../../../../senpi-task/src/dag/node-control-context"
import type { DagSchedulerOptions } from "../../../../senpi-task/src/dag/scheduler"
import type { DagNodeId, DagRunId } from "../../../../senpi-task/src/dag/types"

export type PausedNodeHoldPort = {
  closeHold(taskId: string, cause: "node_cancelled"): Promise<void>
}

export function createPausedNodeCancel(
  options: (runId: DagRunId) => DagSchedulerOptions,
  holds: PausedNodeHoldPort | undefined,
): (runId: DagRunId, nodeId: string) => Promise<void> {
  return async (runId, nodeId) => {
    const context = options(runId)
    if (holds === undefined) throw new DagNodeControlError({
      code: "node_not_continuable", message: "The engine's inherited-hold close port is not configured.", runId,
    })
    await cancelPausedDagNode(context, runId, nodeId as DagNodeId, holds)
  }
}
