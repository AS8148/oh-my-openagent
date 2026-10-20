import type { TaskRecord, TaskRunStats } from "@oh-my-opencode/senpi-task"

// The USD the whole subagent tree under `sessionId` has spent: every task whose root session is this
// one (direct, nested, background, revived and restored children alike), each counted once. A task's
// spend is its earlier runs' (`prior_runs_cost_usd`) plus its current run's reported cost; a live run
// owned here reads the in-flight tracker, so the footer moves while the child works (senpi#2471). A
// run whose provider reported no cost contributes nothing, so subscription children add no figure.
export function subagentTreeCostUsd(
  records: readonly TaskRecord[],
  sessionId: string,
  liveStats?: (taskId: string) => TaskRunStats | undefined,
): number {
  let total = 0
  for (const record of records) {
    if (record.root_session_id !== sessionId) continue
    const current = liveStats?.(record.task_id) ?? record.run_stats
    total += finitePositive(record.prior_runs_cost_usd) + reportedCost(current)
  }
  return total
}

function reportedCost(stats: TaskRunStats | undefined): number {
  return stats?.cost_status === "reported" ? finitePositive(stats.cost_usd) : 0
}

function finitePositive(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0
}
