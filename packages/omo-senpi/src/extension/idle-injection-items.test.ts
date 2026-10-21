import { describe, expect, test } from "bun:test"
import { IdleInjectionCoordinator } from "./idle-injection-coordinator"

describe("coordinator custody preserves individual run items", () => {
  test("#given repeated keys #when final admission is held #then every content has its own notice receipt", () => {
    let delivered = 0
    let held = 0
    const received: string[] = []
    const coordinator = new IdleInjectionCoordinator((message, options) => {
      expect(message.content).toBe("")
      for (const item of options.items) received.push(item.content)
      return options.items.map(item => ({
        itemId: item.itemId, disposition: "notice_persisted" as const, entryId: `notice:${item.itemId}`,
      }))
    })
    for (const content of ["first", "second"]) coordinator.enqueue({
      key: "goal", source: "ulw-continuation", content,
      onFlushed: () => { delivered += 1 },
      onHeld: () => { held += 1 },
    })
    expect(coordinator.pendingCount()).toBe(2)
    expect(coordinator.flushOnIdle()).toBe(2)
    expect(received).toEqual(["first", "second"])
    expect(delivered).toBe(0)
    expect(held).toBe(2)
  })

  test("#given different run references #when flushed #then no admission batch mixes refs", () => {
    const refs: unknown[] = []
    const coordinator = new IdleInjectionCoordinator((_message, options) => {
      const distinct = new Set(options.items.map(item => JSON.stringify(item.runRef)))
      expect(distinct.size).toBe(1)
      refs.push(options.items[0]?.runRef)
    })
    for (const taskId of ["one", "two"]) coordinator.enqueue({
      key: taskId, source: "task-completion", content: taskId,
      runRef: { kind: "task", id: taskId },
    })
    coordinator.flushOnIdle()
    expect(refs).toEqual([{ kind: "task", id: "one" }, { kind: "task", id: "two" }])
  })

  test("#given a formed batch #when Stop lands inside admission #then per-item custody is still possible", async () => {
    const entered = Promise.withResolvers<void>()
    const admit = Promise.withResolvers<void>()
    const receipts: string[] = []
    let held = false
    const coordinator = new IdleInjectionCoordinator(async (_message, options) => {
      entered.resolve()
      await admit.promise
      return options.items.map(item => ({
        itemId: item.itemId,
        disposition: held ? "notice_persisted" as const : "model_consumed" as const,
        entryId: `entry:${item.itemId}`,
      }))
    })
    const done = Promise.withResolvers<void>()
    for (const key of ["a", "b"]) coordinator.enqueue({
      key, source: "task-completion", content: key,
      onFlushed: () => receipts.push("delivered"),
      onHeld: () => { receipts.push(key); if (receipts.length === 2) done.resolve() },
    })
    coordinator.flushOnIdle()
    await entered.promise
    held = true
    admit.resolve()
    await done.promise
    expect(receipts).toEqual(["a", "b"])
  })
})
