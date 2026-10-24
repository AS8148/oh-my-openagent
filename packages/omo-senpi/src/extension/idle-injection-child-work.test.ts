import { describe, expect, it } from "bun:test"

import { IdleInjectionCoordinator } from "./idle-injection-coordinator"
import { WAKE_QUEUE_SOURCE, publishWakeQueueChildWork } from "./wake-queue-source"

// omo#10782 item 2: a child result waiting in the batch window is children's work the parent still owes.
// The coordinator reports how many child entries are queued or in delivery, so the engine never reads
// the parent as done between a child finishing and its result reaching the parent.
function recordingCoordinator(deliver: () => unknown = () => undefined) {
  const counts: number[] = []
  const coordinator = new IdleInjectionCoordinator(deliver, { onChildWorkChange: (count) => counts.push(count) })
  return { coordinator, counts }
}

const completion = (key: string) => ({ key, source: "task-completion" as const, content: `${key} completed` })

describe("IdleInjectionCoordinator child work count (#10782)", () => {
  it("#given a child completion #when it is queued and then delivered #then the count goes 1 then 0", () => {
    const { coordinator, counts } = recordingCoordinator()

    coordinator.enqueue(completion("task:st_1"))
    expect(counts).toEqual([1])

    coordinator.flushOnIdle()
    expect(counts).toEqual([1, 0])
  })

  it("#given an async delivery #when the queue flushes #then the child stays counted until the delivery resolves", async () => {
    let resolveDelivery: () => void = () => undefined
    const delivery = new Promise<void>((resolve) => { resolveDelivery = resolve })
    const { coordinator, counts } = recordingCoordinator(() => delivery)
    coordinator.enqueue(completion("task:st_2"))

    coordinator.flushOnIdle()
    expect(counts).toEqual([1])

    resolveDelivery()
    await delivery
    await Promise.resolve()
    expect(counts).toEqual([1, 0])
  })

  it("#given an async delivery that rejects #when the producer gets its failure receipt #then the queue no longer counts the child", async () => {
    let rejectDelivery: (error: Error) => void = () => undefined
    const delivery = new Promise<void>((_resolve, reject) => { rejectDelivery = reject })
    const { coordinator, counts } = recordingCoordinator(() => delivery)
    coordinator.enqueue({ ...completion("task:st_3"), onDeliveryFailed: () => undefined })

    coordinator.flushOnIdle()
    rejectDelivery(new Error("provider rejected"))
    await delivery.catch(() => undefined)
    await Promise.resolve()

    expect(counts).toEqual([1, 0])
  })

  it("#given only continuation and kibitzer entries #when they are queued and flushed #then no child work is reported", () => {
    const { coordinator, counts } = recordingCoordinator()

    coordinator.enqueue({ key: "ulw", source: "ulw-continuation", content: "continue" })
    coordinator.enqueue({ key: "kibitzer:1", source: "kibitzer", content: "recall", passive: true })
    coordinator.flushOnIdle()

    expect(counts).toEqual([])
  })

  it("#given two child results and a removal #when the queue changes #then each distinct count is reported once", () => {
    const { coordinator, counts } = recordingCoordinator()

    coordinator.enqueue(completion("task:st_4"))
    coordinator.enqueue({ key: "dag:run_1", source: "dag-run", content: "run finished" })
    coordinator.enqueue(completion("task:st_4"))
    coordinator.remove("dag:run_1")

    expect(counts).toEqual([1, 2, 1])
  })

  it("#given a queued child result #when the coordinator retires #then the count clears", () => {
    const { coordinator, counts } = recordingCoordinator()
    coordinator.enqueue({ ...completion("task:st_5"), onDeliveryFailed: () => undefined })

    coordinator.retire()

    expect(counts).toEqual([1, 0])
  })
})

describe("publishWakeQueueChildWork", () => {
  it("#given a count #when published #then senpi sees an omo-wake-queue wake source of kind children", () => {
    const emitted: Array<{ name: string; data: unknown }> = []
    const publish = publishWakeQueueChildWork({ events: { emit: (name: string, data: unknown) => emitted.push({ name, data }) } })

    publish(2)
    publish(0)

    expect(emitted).toEqual([
      { name: "wake_source_state", data: { source: WAKE_QUEUE_SOURCE, kind: "children", activeCount: 2 } },
      { name: "wake_source_state", data: { source: WAKE_QUEUE_SOURCE, kind: "children", activeCount: 0 } },
    ])
  })
})
