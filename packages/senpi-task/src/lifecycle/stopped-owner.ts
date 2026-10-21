import { log } from "@oh-my-opencode/utils"

import type { TaskRecord } from "../state"
import { nowIso, type LifecycleContext } from "./context"
import { destroyResidentTask } from "./destroy"
import type { SuspendFailure, SuspendInput, SuspendSummary } from "./types"

// A session's own task: the record whose child is that session. Once that task is cancelled, lost or
// killed it can never be resumed, so nothing could ever collect a child its session suspended (#10818).
export function stoppedOwnerTask(context: LifecycleContext, sessionId: string): TaskRecord | undefined {
  return context.store.list().records.find((record) =>
    record.child_session_id === sessionId
    && (record.killed === true || record.status === "cancelled" || record.status === "lost"))
}

// Stops every child the stopped owner's session holds, live or still pending, through the one
// destruction port. Each child is cancelled BEFORE its teardown, the same order steering's cancel
// uses, so the child's own settling outcome lands on an already-terminal record and is rejected.
export async function stopOwnedChildren(
  context: LifecycleContext,
  input: SuspendInput,
  owner: TaskRecord,
): Promise<SuspendSummary> {
  const failures: SuspendFailure[] = []
  let disposed = 0
  const reason = `parent task ${owner.task_id} is ${owner.killed === true ? "killed" : owner.status}`
  for (const record of context.store.list().records) {
    if (record.parent_session_id !== input.parentSessionId || record.host_pid !== context.hostPid) continue
    const live = context.registry.get(record.task_id) !== undefined
    if (!live && record.status !== "pending") continue
    try {
      if (record.status === "pending") context.dequeuePending(record.task_id)
      if (record.status === "pending" || record.status === "running") {
        context.store.transition(record.task_id, { type: "cancel", timestamp: nowIso(context), error_message: reason })
        context.store.appendEvent(record.task_id, {
          type: "cancelled", payload: { previous_status: record.status, reason },
        })
      }
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
