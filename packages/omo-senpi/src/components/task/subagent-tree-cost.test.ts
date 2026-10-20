import { describe, expect, it } from "bun:test"

import type { TaskRecord, TaskRunStats, TaskStatus } from "@oh-my-opencode/senpi-task"

import { subagentTreeCostUsd } from "./subagent-tree-cost"

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

function reported(cost: number): TaskRunStats {
  return { runtime_ms: 1, turns: 1, tool_calls: 0, cost_usd: cost, cost_status: "reported" }
}

describe("subagentTreeCostUsd", () => {
  it("#given direct, nested, revived and foreign-tree tasks #when summed #then every task of this tree counts once with its earlier runs", () => {
    // given
    const records = [
      record({ task_id: "st_direct", status: "completed", run_stats: reported(0.5) }),
      record({ task_id: "st_nested", status: "completed", parent_session_id: "child-session", depth: 2, run_stats: reported(0.25) }),
      record({ task_id: "st_revived", status: "completed", prior_runs_cost_usd: 1, run_stats: reported(0.125) }),
      record({ task_id: "st_foreign", status: "completed", root_session_id: "session-b", parent_session_id: "session-b", run_stats: reported(9) }),
    ]

    // when
    const total = subagentTreeCostUsd(records, "session-a")

    // then
    expect(total).toBeCloseTo(1.875, 10)
  })

  it("#given a running child owned here #when summed #then its in-flight tracker cost counts instead of the record", () => {
    // given
    const running = record({ task_id: "st_running", status: "running", prior_runs_cost_usd: 0.5 })

    // when
    const total = subagentTreeCostUsd([running], "session-a", (taskId) => (taskId === "st_running" ? reported(0.25) : undefined))

    // then
    expect(total).toBeCloseTo(0.75, 10)
  })

  it("#given children whose cost was unreported or invalid #when summed #then they add no figure", () => {
    // given
    const records = [
      record({ task_id: "st_sub", status: "completed", run_stats: { runtime_ms: 1, turns: 3, tool_calls: 2, cost_status: "unavailable" } }),
      record({ task_id: "st_bad", status: "completed", run_stats: { runtime_ms: 1, turns: 1, tool_calls: 0, cost_usd: Number.NaN, cost_status: "invalid" } }),
    ]

    // when / then
    expect(subagentTreeCostUsd(records, "session-a")).toBe(0)
  })
})
