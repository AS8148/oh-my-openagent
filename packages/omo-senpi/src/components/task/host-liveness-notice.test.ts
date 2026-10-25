import { expect, test } from "bun:test"
import { makeRecord } from "../../../../senpi-task/src/tools/output/__fixtures__/records"
import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import { IdleInjectionCoordinator } from "../../extension/idle-injection-coordinator"
import { notifyHostLiveness } from "./host-liveness-notice"

test("parent liveness notifications are statuses, not terminal completions", async () => {
  const delivered: unknown[] = []
  const flushed = Promise.withResolvers<undefined>()
  const coordinator = new IdleInjectionCoordinator((_message, options) => {
    delivered.push(...options.items.map(item => ({
      source: item.producer, type: item.customType, details: item.details,
    })))
    flushed.resolve(undefined)
  })
  const record = makeRecord({ task_id: "st_live", status: "running" })
  notifyHostLiveness(new FakeExtensionAPI(), coordinator, record, { state: "unresponsive", since: 40_000 })
  notifyHostLiveness(new FakeExtensionAPI(), coordinator, record, { state: "running" })
  await flushed.promise
  expect(delivered).toEqual([
    { source: "task-status", type: "senpi-task.status", details: { task_id: "st_live", run_epoch: record.notification.run_epoch, state: "unresponsive", since: 40_000 } },
    { source: "task-status", type: "senpi-task.status", details: { task_id: "st_live", run_epoch: record.notification.run_epoch, state: "running" } },
  ])
  expect(coordinator.pendingCount()).toBe(0)
  coordinator.retire()
})
