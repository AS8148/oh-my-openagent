import type { TaskRecordStore } from "../store"
import type { ManagedChildHandle } from "./child-handle"

export async function settlePaused(
  ports: {
    readonly store: TaskRecordStore
    readonly now: () => number
    readonly liveHandle: (taskId: string) => ManagedChildHandle | undefined
    readonly parkSlot?: (taskId: string, epoch: number) => void
  },
  taskId: string,
  handle: ManagedChildHandle,
  epoch: number,
  acknowledged: Promise<void>,
): Promise<void> {
  await acknowledged
  if (ports.liveHandle(taskId) !== handle) return
  const record = ports.store.load(taskId)
  if (record?.notification.run_epoch !== epoch) return
  if (record.status !== "running" && record.status !== "paused") return
  if (record.status === "running") ports.store.transition(taskId, {
    type: "pause", timestamp: new Date(ports.now()).toISOString(),
  })
  ports.parkSlot?.(taskId, epoch)
}
