import type { StartResult } from "../../manager"

type StartedResult = Extract<StartResult, { kind: "started" | "starting" }>

export type StartLabels = {
  readonly taskSummary?: string
  readonly description?: string
}

export function backgroundStartText(started: StartedResult, labels: StartLabels): string {
  const starting = started.kind === "starting"
  const queue = started.kind === "started" && started.queue_position !== undefined
    ? ` queued at position ${started.queue_position}`
    : starting ? ", the task host is still admitting it; a failed start arrives as its notification" : ""
  const verb = starting ? "Starting" : "Started"
  const status = starting ? "starting" : started.status
  const label = labels.taskSummary ?? labels.description ?? started.name
  const base =
    label === started.task_id
      ? `${verb} task ${started.task_id} (${status})${queue}. Completion is automatically delivered. End your turn if no independent work remains; otherwise keep working. Use task_send only to steer it.`
      : `${verb} task ${label} (${started.task_id}, ${status})${queue}. Completion is automatically delivered. End your turn if no independent work remains; otherwise keep working. Use task_send only to steer it.`
  return base
}

export function backgroundConversionText(
  started: StartedResult,
  labels: StartLabels,
  budgetSeconds: number,
): string {
  const prefix = `Foreground wait reached the prompt-cache-safe budget (${budgetSeconds}s) for task ${started.task_id}; the task continues in background. Completion will arrive as a notification; steer with task_send, read with task_output.`
  return `${prefix}\n\n${backgroundStartText(started, labels)}`
}
