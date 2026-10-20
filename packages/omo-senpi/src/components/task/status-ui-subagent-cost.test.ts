import { describe, expect, it } from "bun:test"

import type { TaskRecord, TaskRunStats, TaskStatus } from "@oh-my-opencode/senpi-task"

import type { CapturedUi } from "./runtime-context"
import { createTaskStatusUi, type StatusUiManager, type StatusUiTimers } from "./status-ui"

function record(overrides: Partial<TaskRecord> & { task_id: string; status: TaskStatus }): TaskRecord {
  return {
    parent_session_id: "session-a",
    root_session_id: "session-a",
    depth: 1,
    execution_mode: "in-process",
    model: "zai/glm-5.3",
    residency_state: "resident",
    created_at: "2026-10-20T00:00:00.000Z",
    updated_at: "2026-10-20T00:00:01.000Z",
    notify_on_terminal: false,
    notification: { run_epoch: 0, notified_epoch: -1 },
    ...overrides,
  }
}

const timers: StatusUiTimers = { set: () => 1, clear: () => undefined }

function ui(costs: Array<number | undefined>, withCostApi = true): CapturedUi {
  return {
    notify: () => undefined,
    setStatus: () => undefined,
    setWidget: () => undefined,
    select: () => Promise.resolve(undefined),
    confirm: () => Promise.resolve(false),
    ...(withCostApi ? { setSubagentCost: (cost: number | undefined) => costs.push(cost) } : {}),
  }
}

describe("createTaskStatusUi subagent tree cost (senpi#2471)", () => {
  it("#given a finished and a live child #when synced twice #then the footer gets the tree total once and again only when it moves", () => {
    // given
    let live: TaskRunStats = { runtime_ms: 1, turns: 1, tool_calls: 0, cost_usd: 0.25, cost_status: "reported" }
    const records = [
      record({ task_id: "st_done", status: "completed", run_stats: { runtime_ms: 1, turns: 2, tool_calls: 1, cost_usd: 0.5, cost_status: "reported" } }),
      record({ task_id: "st_live", status: "running" }),
    ]
    const manager: StatusUiManager = {
      list: () => records.map((task) => ({ record: task })),
      runStatsSnapshot: (taskId) => (taskId === "st_live" ? live : undefined),
    }
    const costs: Array<number | undefined> = []
    const statusUi = createTaskStatusUi({ manager, runtime: { ui: () => ui(costs), sessionId: () => "session-a", mode: () => "tui" }, timers })

    // when
    statusUi.syncNow()
    statusUi.syncNow()
    live = { ...live, cost_usd: 0.5 }
    statusUi.syncNow()

    // then
    expect(costs).toEqual([0.75, 1])
  })

  it("#given an engine without setSubagentCost #when synced #then the widget still renders and nothing throws", () => {
    // given
    const manager: StatusUiManager = { list: () => [{ record: record({ task_id: "st_done", status: "completed" }) }] }
    const statusUi = createTaskStatusUi({ manager, runtime: { ui: () => ui([], false), sessionId: () => "session-a", mode: () => "tui" }, timers })

    // when / then
    expect(() => statusUi.syncNow()).not.toThrow()
  })
})
