import { open } from "node:fs/promises"

import type { InputEffectStatus } from "./reconcile-turn"

/**
 * The newest admission receipt of this task's last identified input, read from the session
 * transcript where senpi writes it (`rpc_client_message_admission`, the same entries its own
 * `get_effect_status { sessionPath }` answers from). Ids are `<taskId>:<epoch>:<seq>`, so the
 * newest entry carrying this task's prefix is the receipt of its last send.
 */

const ADMISSION_ENTRY = "rpc_client_message_admission"
const INITIAL_TAIL_BYTES = 64 * 1024
const RECONCILED_OUTCOMES = new Set(["completed", "aborted", "interrupted_by_reopen", "deadline", "error"])
const ADMISSION_STATES: Readonly<Record<string, InputEffectStatus["state"]>> = {
  queued: "accepted",
  running: "applied",
  completed: "done",
}

export async function readLastInputReceipt(sessionPath: string, taskId: string): Promise<InputEffectStatus | undefined> {
  let file
  try {
    file = await open(sessionPath, "r")
  } catch {
    return undefined
  }
  try {
    const { size } = await file.stat()
    for (let bytes = Math.min(size, INITIAL_TAIL_BYTES); ; bytes = Math.min(size, bytes * 2)) {
      const start = size - bytes
      const buffer = Buffer.alloc(bytes)
      await file.read(buffer, 0, bytes, start)
      const lines = buffer.toString("utf8").split("\n")
      // A chunk that starts mid-file begins inside a line; only a read from 0 owns its first line.
      const complete = start === 0 ? lines : lines.slice(1)
      for (let index = complete.length - 1; index >= 0; index--) {
        const receipt = receiptOf(complete[index] ?? "", taskId)
        if (receipt !== undefined) return receipt
      }
      if (start === 0) return undefined
    }
  } finally {
    await file.close()
  }
}

function receiptOf(line: string, taskId: string): InputEffectStatus | undefined {
  if (!line.includes(ADMISSION_ENTRY) || !line.includes(`${taskId}:`)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || parsed.type !== "custom" || parsed.customType !== ADMISSION_ENTRY || !isRecord(parsed.data)) return undefined
  const data = parsed.data
  if (typeof data.clientMessageId !== "string" || !data.clientMessageId.startsWith(`${taskId}:`)) return undefined
  const state = typeof data.state === "string" ? ADMISSION_STATES[data.state] : undefined
  if (state === undefined) return undefined
  const outcome = isRecord(data.outcome) ? data.outcome : undefined
  if (state !== "done" || outcome === undefined) return { state }
  // A dropped or cleared input never ran: it is a failed receipt, which reconciliation reads as no outcome.
  if (typeof outcome.kind !== "string" || !RECONCILED_OUTCOMES.has(outcome.kind)) return { state: "failed" }
  return {
    state,
    outcome: {
      kind: outcome.kind as NonNullable<InputEffectStatus["outcome"]>["kind"],
      ...(isRecord(outcome.deadline) ? { deadline: outcome.deadline } : {}),
      ...(typeof outcome.reason === "string" ? { reason: outcome.reason } : {}),
      ...(typeof outcome.detail === "string" ? { detail: outcome.detail } : {}),
      ...(typeof outcome.action === "string" ? { action: outcome.action } : {}),
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
