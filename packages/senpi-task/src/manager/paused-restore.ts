import type { ReattachResult, RespawnResult } from "../lifecycle/port"
import { newestSessionPath } from "../lifecycle/session-path"
import type { RunPauseOwner } from "../pause/ports"
import type { TaskRecord } from "../state"
import type { TaskRecordStore } from "../store"
import type { ManagedChildHandle } from "./child-handle"

export class PausedChildLostError extends Error {
  readonly code = "paused_child_lost"
  constructor(readonly taskId: string, reason: string) {
    super(`paused child ${taskId} cannot be restored: ${reason}`)
  }
}

export type PausedRestorePorts = {
  readonly store: TaskRecordStore
  readonly hostPid: number
  respawn(record: TaskRecord, sessionPath: string): Promise<RespawnResult>
  reattach(record: TaskRecord, handle: ManagedChildHandle): Promise<ReattachResult>
  liveHandle(taskId: string): ManagedChildHandle | undefined
}

export function savedRunOwner(record: TaskRecord): RunPauseOwner | undefined {
  const saved = record.run_pause
  return saved === undefined ? undefined
    : { parentSessionId: saved.parent_session_id, parentPauseSeq: saved.parent_pause_seq, runRef: saved.run_ref }
}

/**
 * A paused child whose host is gone is rebuilt from its own transcript under this host, at its
 * recorded epoch and with no turn started (design 5.2: it respawns only as paused). A child with no
 * transcript is lost: its prompt is never replayed.
 */
export async function restorePausedChild(ports: PausedRestorePorts, record: TaskRecord): Promise<ManagedChildHandle> {
  const taskId = record.task_id
  const sessionPath = newestSessionPath(ports, taskId)
  if (sessionPath === undefined) throw new PausedChildLostError(taskId, "its session transcript is gone")
  let claimed = false
  ports.store.mutate(taskId, fresh => {
    if (fresh.status !== "paused" || fresh.killed === true || fresh.notification.run_epoch !== record.notification.run_epoch) return fresh
    claimed = true
    return { ...fresh, host_pid: ports.hostPid, residency_state: "resident" }
  })
  const current = ports.store.load(taskId)
  if (!claimed || current === null || current === undefined) throw new Error(`paused child ${taskId} changed before its restore`)
  const respawned = await ports.respawn(current, sessionPath)
  if (!respawned.ok) {
    if (respawned.disposition === "unrecoverable") throw new PausedChildLostError(taskId, respawned.reason)
    throw new Error(`paused child ${taskId} restore failed (${respawned.code}): ${respawned.reason}`)
  }
  const reattached = await ports.reattach(current, respawned.handle)
  if (!reattached.ok && reattached.kind !== "already_attached") throw new Error(`paused child ${taskId} reattach failed: ${reattached.reason}`)
  const handle = ports.liveHandle(taskId)
  if (handle === undefined) throw new Error(`paused child ${taskId} has no handle after its restore`)
  return handle
}
