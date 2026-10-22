import { afterEach, describe, expect, test } from "bun:test"

import type { TaskStatus } from "../state"
import { createTaskLifecycle } from "./create"
import {
  cleanupProjects, FakeRegistry, fakeHandle, readEvents, seedRecord, settings, tempStore, type CallLog,
} from "./__fixtures__/lifecycle-fakes"
import { NO_HOST_ENDPOINT } from "./host-session"

afterEach(() => cleanupProjects())

const PARENT_SESSION = "parent-1"
const CHILD = "st_000000c1"

function stoppedOwnerWorld(child: { status: TaskStatus; live: boolean; queued?: number; settlesAfterSnapshot?: boolean }) {
  const store = tempStore()
  seedRecord(store, {
    task_id: "st_000000b0", parent_session_id: "root-1", status: "cancelled",
    execution_mode: "process", child_session_id: PARENT_SESSION, host_pid: process.pid,
  })
  seedRecord(store, {
    task_id: CHILD, parent_session_id: PARENT_SESSION, status: child.status, execution_mode: "in-process",
    residency_state: "resident", host_pid: process.pid,
  })
  if ((child.queued ?? 0) > 0) {
    store.mutate(CHILD, (record) => ({
      ...record,
      pending_steering: Array.from({ length: child.queued ?? 0 }, (_, index) => ({
        id: `q${index}`, message: `queued ${index}`, deliver_as: "followUp" as const,
      })),
    }))
  }
  const order: CallLog = []
  const registry = new FakeRegistry()
  if (child.live) registry.add(fakeHandle(CHILD, "in-process", order))
  const dequeued: string[] = []
  // The child settles between the shutdown's record snapshot and its cancel write: the snapshot still
  // reads running while the store already holds the child's own completed outcome.
  const snapshot = store.list()
  if (child.settlesAfterSnapshot === true) {
    store.transition(CHILD, { type: "complete", timestamp: new Date().toISOString(), final_response: "done on its own" })
  }
  const viewedStore = child.settlesAfterSnapshot === true
    ? new Proxy(store, {
      get: (target, key) => {
        if (key === "list") return () => snapshot
        const value: unknown = Reflect.get(target, key)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    : store
  const lifecycle = createTaskLifecycle({
    hostEndpoint: NO_HOST_ENDPOINT, store: viewedStore, registry, config: settings(),
    dequeuePending: (taskId) => dequeued.push(taskId),
  })
  return { store, order, dequeued, lifecycle }
}

describe("stopped owner's children at the record level", () => {
  test("#given a pending child with no handle #when the stopped owner's session shuts down #then it is dequeued and cancelled, never parked to relaunch", async () => {
    const { store, dequeued, lifecycle } = stoppedOwnerWorld({ status: "pending", live: false })

    const summary = await lifecycle.suspendOnSessionShutdown({ parentSessionId: PARENT_SESSION, reason: "quit" })

    expect(dequeued).toEqual([CHILD])
    expect(store.load(CHILD)?.status).toBe("cancelled")
    expect(readEvents(store, CHILD)).toContain("cancelled")
    expect(summary.suspended_pending).toBe(0)
    expect(summary.disposed).toBe(1)
  })

  test("#given a child that already settled on its own #when the stopped owner's session shuts down #then it keeps its outcome and no cancelled event is written", async () => {
    const { store, order, lifecycle } = stoppedOwnerWorld({ status: "running", live: true, settlesAfterSnapshot: true })

    await lifecycle.suspendOnSessionShutdown({ parentSessionId: PARENT_SESSION, reason: "quit" })

    expect(store.load(CHILD)?.status).toBe("completed")
    expect(readEvents(store, CHILD)).not.toContain("cancelled")
    expect(order).toContain(`dispose:${CHILD}`)
  })

  test("#given a running child with queued steering #when the stopped owner's session shuts down #then the queue is dropped with a record of how many", async () => {
    const { store, lifecycle } = stoppedOwnerWorld({ status: "running", live: true, queued: 2 })

    await lifecycle.suspendOnSessionShutdown({ parentSessionId: PARENT_SESSION, reason: "quit" })

    const record = store.load(CHILD)
    expect(record?.status).toBe("cancelled")
    expect(record?.pending_steering).toBeUndefined()
    expect(readEvents(store, CHILD)).toEqual(expect.arrayContaining(["steer_dropped", "cancelled"]))
  })
})
