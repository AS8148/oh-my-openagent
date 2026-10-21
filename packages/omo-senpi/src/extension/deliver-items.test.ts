import { describe, expect, test } from "bun:test"
import { IdleInjectionCoordinator } from "./idle-injection-coordinator"
import { deliverItems, type NativeItemMessage } from "./deliver-items"

describe("native per-item run admission", () => {
  test("#given a formed coordinator batch #when the engine fences its run #then each original content becomes an independent notice", async () => {
    const messages: NativeItemMessage[] = []
    let held = 0
    let modelDeliveries = 0
    const finished = Promise.withResolvers<void>()
    const coordinator = new IdleInjectionCoordinator((_message, options) => deliverItems(
      message => {
        messages.push(message)
        const disposition = message.details.runRef?.id === "fenced" ? "notice_persisted" as const : "model_consumed" as const
        return { itemId: message.details.itemId, disposition, entryId: `entry:${message.details.itemId}` }
      }, options,
    ))
    for (const content of ["first", "second"]) coordinator.enqueue({
      key: "same-key", source: "task-completion", content, runRef: { kind: "task", id: "fenced" },
      onHeld: () => { held += 1; if (held + modelDeliveries === 3) finished.resolve() },
      onFlushed: () => { modelDeliveries += 1; if (held + modelDeliveries === 3) finished.resolve() },
    })
    coordinator.enqueue({
      key: "unrelated", source: "ulw-continuation", content: "unrelated work",
      onFlushed: () => { modelDeliveries += 1; if (held + modelDeliveries === 3) finished.resolve() },
    })
    coordinator.flushOnIdle()
    await finished.promise
    expect(messages.map(message => message.content)).toEqual(["first", "second", "unrelated work"])
    expect(messages.map(message => message.details.runRef)).toEqual([
      { kind: "task", id: "fenced" }, { kind: "task", id: "fenced" }, undefined,
    ])
    expect(new Set(messages.map(message => message.details.itemId)).size).toBe(3)
    expect(held).toBe(2)
    expect(modelDeliveries).toBe(1)
  })
})
