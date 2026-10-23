// senpi's wake-source event (senpi#3864): a live source of kind "children" keeps the session's lifecycle
// off "done". The idle-injection queue publishes the child results it holds or is delivering under it.
export const WAKE_QUEUE_STATE_EVENT = "wake_source_state"
export const WAKE_QUEUE_SOURCE = "omo-wake-queue"

interface WakeQueueEvents {
  readonly events?: { readonly emit: (name: string, data: unknown) => void }
}

export function publishWakeQueueChildWork(pi: WakeQueueEvents): (count: number) => void {
  return (count) => {
    pi.events?.emit(WAKE_QUEUE_STATE_EVENT, { source: WAKE_QUEUE_SOURCE, kind: "children", activeCount: count })
  }
}
