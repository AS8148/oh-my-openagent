import { log } from "@oh-my-opencode/utils"

import type { TaskRecord } from "../state"
import { withDroppedSteeringNotice } from "../state/queued-steering"
import { nowIso, type LifecycleContext } from "./context"
import { destroyResidentTask } from "./destroy"
import type { SuspendFailure, SuspendInput, SuspendSummary } from "./types"

// A session's own task: the record whose child is that session. Once that task is cancelled, lost or
// killed it can never be resumed, so nothing could ever collect a child its session suspended (#10818).
// A cancel that is still landing counts too: the unreachable-child stop and the revival's pending
// cancel both end the session BEFORE the record turns cancelled, with only cancel_requested set.
export function stoppedOwnerTask(context: LifecycleContext, sessionId: string): TaskRecord | undefined {
  return context.store.list().records.find((record) =>
    record.child_session_id === sessionId
    && (record.killed === true || record.status === "cancelled" || record.status === "lost"
      || record.cancel_requested !== undefined))
}

// Stops every child the stopped owner's session holds, live or still pending, through the one
// destruction port, with the same steps as steering's cancel: the record is cancelled BEFORE teardown
// (so the child's own settling outcome is rejected), its queued steering is dropped with a notice, and
// a live handle is marked stopping so a recovering transport ends the session instead of resuming it.
export async function stopOwnedChildren(
  context: LifecycleContext,
  input: SuspendInput,
  owner: TaskRecord,
): Promise<SuspendSummary> {
  const failures: SuspendFailure[] = []
  let disposed = 0
  const reason = `parent task ${owner.task_id} was ${owner.killed === true ? "killed" : owner.status === "running" ? "cancelled" : owner.status}`
  for (const record of context.store.list().records) {
    if (record.parent_session_id !== input.parentSessionId || record.host_pid !== context.hostPid) continue
    const handle = context.registry.get(record.task_id)
    if (handle === undefined && record.status !== "pending") continue
    try {
      if (record.status === "pending") context.dequeuePending(record.task_id)
      if (record.status === "pending" || record.status === "running") cancelChild(context, record, reason)
      handle?.markStopping?.()
      await destroyResidentTask(context, record.task_id, "cancel")
      disposed += 1
    } catch (error) {
      failures.push({ task_id: record.task_id, error: String(error) })
    }
  }
  const summary: SuspendSummary = {
    suspended_in_process: 0, suspended_rpc: 0, suspended_pending: 0, disposed, failures,
  }
  log("senpi-task session shutdown stopped the children of a stopped task", {
    parentSessionId: input.parentSessionId, owner: owner.task_id, ...summary,
  })
  return summary
}

function cancelChild(context: LifecycleContext, record: TaskRecord, reason: string): void {
  const undelivered = record.pending_steering?.length ?? 0
  const result = context.store.transition(record.task_id, {
    type: "cancel", timestamp: nowIso(context), error_message: withDroppedSteeringNotice(reason, undelivered) ?? reason,
  })
  // A child that settled on its own in the meantime keeps its own outcome: no cancelled event for it.
  if (!result.applied) return
  if (undelivered > 0) {
    context.store.mutate(record.task_id, (fresh) => {
      const { pending_steering: _dropped, ...rest } = fresh
      return rest
    })
    context.store.appendEvent(record.task_id, { type: "steer_dropped", payload: { count: undelivered, reason: "cancelled" } })
  }
  context.store.appendEvent(record.task_id, { type: "cancelled", payload: { previous_status: record.status, reason } })
}
