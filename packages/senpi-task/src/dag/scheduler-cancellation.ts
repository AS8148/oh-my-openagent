import { dagRunCancelledEvent } from "./events"
import { countNodes, errorMessage, failNode, isLiveTask, liveOwnedTask, transition, TERMINAL_NODE_STATES, type SchedulerContext } from "./scheduler-context"
import { disposePromotionWatch } from "./scheduler-task-attachment"
import type { DagNodeId, DagRunId } from "./types"
import type { DagRunRecordV1 } from "./manager"

export async function cancelRun(context: SchedulerContext, runId: DagRunId, reason?: string): Promise<void> {
  const snapshot = context.journal.snapshot()
  if (snapshot.runId !== runId) throw new Error(`scheduler does not own DAG run "${runId}"`)
  if (snapshot.status === "completed" || snapshot.status === "failed" || snapshot.status === "cancelled") return
  if (context.cancellationOperation !== undefined) return context.cancellationOperation

  context.cancellationStarted = true
  context.infrastructureRetries.cancelPendingTimers()
  context.resolveCancellationRequested()
  context.cancellationOperation = performCancellation(context, reason)
  return context.cancellationOperation
}

async function performCancellation(context: SchedulerContext, reason?: string): Promise<void> {
  try {
    await whenAdmissionIdle(context)
    // Watches go first so a promotion racing the cancel cannot flip nodes mid-cancellation.
    for (const nodeId of [...context.promotionWatches.keys()]) disposePromotionWatch(context, nodeId)
    // Every child the run owns, not only the attached ones: a completed node's child that resumed on
    // its own is no longer attached but still works in the node's worktree (#11381).
    const taskIds = new Set(context.attachedTaskIds.values())
    for (const node of context.journal.snapshot().nodes) {
      const owned = liveOwnedTask(context, node.id)
      if (owned !== undefined) taskIds.add(owned.task_id)
    }
    const cancellationResults = await Promise.allSettled([...taskIds].map((taskId) =>
      context.taskManager.cancelTask(taskId, reason, { abort: "skip" }),
    ))
    const cancellationFailure = cancellationResults.find((result) => result.status === "rejected")
    const cancelledNodeIds: DagNodeId[] = []
    for (const node of context.journal.snapshot().nodes) {
      if (TERMINAL_NODE_STATES.has(node.state)) continue
      transition(context, node.id, "cancelled", { kind: "cancelled" })
      cancelledNodeIds.push(node.id)
    }
    const cancelled = context.journal.snapshot()
    context.journal.append(Object.assign(
      dagRunCancelledEvent({ reason, counts: countNodes(cancelled.nodes) }),
      { cancelledNodeIds },
    ))
    context.attachedTaskIds.clear()
    if (cancellationFailure?.status === "rejected") throw cancellationFailure.reason
  } finally {
    context.resolveCancellationCompleted()
  }
}

type SupersededChild = { readonly nodeId: DagNodeId; readonly taskId: string; readonly execAttempt: number }

/** Live children of an earlier attempt of a node still to be admitted (an amend or a retry bumped its execAttempt). */
export function supersededChildren(context: SchedulerContext): readonly SupersededChild[] {
  return context.journal.snapshot().nodes.flatMap((node) => {
    if (node.state !== "pending" && node.state !== "blocked") return []
    const task = liveOwnedTask(context, node.id)
    const execAttempt = node.execAttempt ?? 0
    return task === undefined || (task.owner?.execAttempt ?? 0) === execAttempt ? [] : [{ nodeId: node.id, taskId: task.task_id, execAttempt }]
  })
}

/**
 * Stops superseded children before any new attempt starts, so a replaced definition never keeps
 * writing beside, or gets adopted as, the new one (#11381). A child that cannot be stopped fails its
 * node with the retryable `stale_attempt_alive`. Runs as an admission pass, so cancel and suspend
 * wait for it.
 */
export async function disposeSupersededChildren(context: SchedulerContext, stale: readonly SupersededChild[]): Promise<void> {
  context.admissionInProgress = true
  let results: PromiseSettledResult<unknown>[]
  try {
    results = await Promise.allSettled(stale.map(({ nodeId, taskId, execAttempt }) =>
      context.taskManager.cancelTask(taskId, `superseded by attempt ${execAttempt} of DAG node "${nodeId}"`)))
  } finally {
    context.admissionInProgress = false
    resolveAdmissionIdle(context)
  }
  if (context.suspended || context.cancellationStarted) return
  stale.forEach(({ nodeId, taskId }, index) => {
    const task = context.taskManager.get(taskId)
    if (!isLiveTask(task)) return
    const result = results[index]
    const cause = result?.status === "rejected" ? `: ${errorMessage(result.reason)}` : ""
    failNode(context, nodeId, "stale_attempt_alive", `task ${taskId} of a superseded attempt is still ${task?.status} and could not be stopped${cause}`)
  })
}

export async function cancelledSnapshot(context: SchedulerContext): Promise<DagRunRecordV1> {
  if (context.suspended && !context.cancellationStarted) return context.journal.snapshot()
  await context.cancellationCompleted
  return context.journal.snapshot()
}

export function whenAdmissionIdle(context: SchedulerContext): Promise<void> {
  if (!context.admissionInProgress) return Promise.resolve()
  return new Promise<void>((resolve) => context.admissionIdleWaiters.add(resolve))
}

export function resolveAdmissionIdle(context: SchedulerContext): void {
  for (const resolve of context.admissionIdleWaiters) resolve()
  context.admissionIdleWaiters.clear()
}
