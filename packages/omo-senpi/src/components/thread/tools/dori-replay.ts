/**
 * The replay journal of the agent toolkit's layer-2 calls (engine side). It ships as its own sidecar
 * (`runtime/dori/replay.js`) and is loaded only while the `dori` section is on. A call's identity is
 * its turn, its call index, its op and its canonical arguments: `["turn", turnId, callIndex]` is
 * claimed with the op and an argument hash before the host op runs. A recorded identity returns its
 * result without dispatching; the same key with another op or other arguments stops as a typed
 * divergence; a key claimed by a run that never recorded stops as pending, because re-sending could
 * deliver twice; and a turn older than the seven-day window never dispatches again, whether or not
 * its rows were pruned.
 */
import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

import { Sql, type SqliteConnection } from "../gateway/sql"
import { DORI_REPLAY_CONTEXT_ARG } from "../../ulw-loop/sdk/dori-gate"
import { TOOLKIT_REPLAY_RETENTION_MS, toolkitReplayKey } from "../../ulw-loop/sdk/dori/replay-key"

export const REPLAY_CONTEXT_ARG = DORI_REPLAY_CONTEXT_ARG

export type ReplayStopCode = "toolkit_replay_divergence" | "toolkit_replay_pending" | "toolkit_replay_expired" | "toolkit_replay_turn_unknown"

export type ReplayStop = {
  readonly kind: "replay_stopped"
  readonly code: ReplayStopCode
  readonly message: string
  readonly key?: string
  readonly differs?: readonly ("op" | "args")[]
  readonly recorded_op?: string
  readonly attempted_op?: string
}

/** One call's place: the turn the calling cell started in, when that turn was written, and the call's index in the cell. */
export type ReplayTurn = { readonly turnId: string; readonly turnAt: number; readonly callIndex: number }

export interface DoriReplay {
  run(turn: ReplayTurn, op: string, args: unknown, dispatch: () => Promise<unknown>): Promise<unknown>
  close(): void
}

type Claim =
  | { readonly kind: "claimed" }
  | { readonly kind: "recorded"; readonly result: unknown }
  | { readonly kind: "diverged"; readonly recordedOp: string; readonly differs: readonly ("op" | "args")[] }
  | { readonly kind: "pending" }

const BUSY_TIMEOUT_MS = 5_000

const SCHEMA = `CREATE TABLE IF NOT EXISTS toolkit_replay (
  replay_key TEXT PRIMARY KEY,
  op TEXT NOT NULL,
  args_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'recorded')),
  result_json TEXT,
  turn_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS toolkit_replay_turn_at ON toolkit_replay (turn_at);`

function stop(code: ReplayStopCode, message: string, fields: Omit<ReplayStop, "kind" | "code" | "message"> = {}): ReplayStop {
  return { kind: "replay_stopped", code, message, ...fields }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value)

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}

/** sha256 of the arguments as JSON with every object's keys sorted, so key order never makes a call look different. */
export function argsHash(args: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(args ?? null))).digest("hex")
}

/** The SDK's carried context, and the arguments the op sees without it. Only that one argument is taken; key-shaped op arguments stay arguments. */
export function splitReplayContext(args: unknown): { readonly carried: unknown; readonly args: unknown } {
  if (!isRecord(args) || !Object.hasOwn(args, REPLAY_CONTEXT_ARG)) return { carried: undefined, args }
  const { [REPLAY_CONTEXT_ARG]: carried, ...rest } = args
  return { carried, args: rest }
}

type BranchEntry = { readonly type?: unknown; readonly id?: unknown; readonly timestamp?: unknown; readonly message?: { readonly role?: unknown; readonly content?: unknown } }

/**
 * The turn a call belongs to, issued only from the calling session's own branch: the assistant entry
 * holding the tool call that is the calling cell (the carried eval cell, or the tool call itself when
 * the model called the tool directly). A cell that outlives its turn keeps that turn; a cell id that
 * is not a tool call on the caller's branch, or a malformed index, is refused.
 */
export function resolveReplayTurn(callerDurableId: string, ectx: unknown, carried: unknown, toolCallId: string): ReplayTurn | ReplayStop {
  let cell = toolCallId
  let callIndex = 0
  if (carried !== undefined) {
    if (!isRecord(carried) || typeof carried.cell !== "string" || carried.cell.length === 0 || !Number.isSafeInteger(carried.index) || (carried.index as number) < 0) {
      return stop("toolkit_replay_turn_unknown", "The carried replay context is malformed; the call was not run.")
    }
    cell = carried.cell
    callIndex = carried.index as number
  }
  const manager = (ectx as { readonly sessionManager?: { readonly getBranch?: () => readonly unknown[] } } | undefined)?.sessionManager
  const branch = typeof manager?.getBranch === "function" ? manager.getBranch() : []
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index] as BranchEntry | undefined
    if (entry?.type !== "message" || entry.message?.role !== "assistant" || typeof entry.id !== "string") continue
    const content = Array.isArray(entry.message.content) ? entry.message.content : []
    if (!content.some((part) => isRecord(part) && part.type === "toolCall" && part.id === cell)) continue
    const turnAt = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN
    if (!Number.isFinite(turnAt)) break
    return { turnId: `${callerDurableId}:${entry.id}/${cell}`, turnAt, callIndex }
  }
  return stop("toolkit_replay_turn_unknown", `Cell ${cell} is not a tool call on the calling session's branch, so this engine did not issue its turn; the call was not run.`)
}

function inTransaction<T>(sql: Sql, body: () => T): T {
  sql.exec("BEGIN IMMEDIATE")
  try {
    const value = body()
    sql.exec("COMMIT")
    return value
  } catch (error) {
    sql.exec("ROLLBACK")
    throw error
  }
}

function claim(sql: Sql, key: string, op: string, hash: string, turnAt: number, now: number): Claim {
  return inTransaction(sql, () => {
    sql.run("DELETE FROM toolkit_replay WHERE turn_at < ?", [now - TOOLKIT_REPLAY_RETENTION_MS])
    const row = sql.one(["op", "args_sha256", "state", "result_json"], "SELECT op, args_sha256, state, result_json FROM toolkit_replay WHERE replay_key = ?", [key])
    if (row === undefined) {
      sql.run("INSERT INTO toolkit_replay (replay_key, op, args_sha256, state, turn_at, created_at) VALUES (?, ?, ?, 'pending', ?, ?)", [key, op, hash, turnAt, now])
      return { kind: "claimed" }
    }
    const differs = [...(row.op === op ? [] : ["op" as const]), ...(row.args_sha256 === hash ? [] : ["args" as const])]
    if (differs.length > 0) return { kind: "diverged", recordedOp: String(row.op), differs }
    if (row.state !== "recorded") return { kind: "pending" }
    return { kind: "recorded", result: JSON.parse(String(row.result_json)) as unknown }
  })
}

export async function openDoriReplay(options: { readonly path: string; readonly now?: () => number }): Promise<DoriReplay> {
  mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 })
  const sqlite = await import("node:sqlite")
  const connection = new sqlite.DatabaseSync(options.path, { timeout: BUSY_TIMEOUT_MS }) as unknown as SqliteConnection
  const sql = new Sql(connection)
  sql.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
  sql.exec("PRAGMA journal_mode = WAL")
  sql.exec(SCHEMA)
  const now = options.now ?? Date.now
  sql.run("DELETE FROM toolkit_replay WHERE turn_at < ?", [now() - TOOLKIT_REPLAY_RETENTION_MS])
  let closed = false
  return {
    async run(turn, op, args, dispatch) {
      const key = toolkitReplayKey(turn.turnId, turn.callIndex)
      const at = now()
      if (at - turn.turnAt > TOOLKIT_REPLAY_RETENTION_MS) {
        return stop("toolkit_replay_expired", `Call ${key} (${op}) belongs to a turn older than the seven-day replay window; it was not run again.`, { key, attempted_op: op })
      }
      const claimed = claim(sql, key, op, argsHash(args), turn.turnAt, at)
      if (claimed.kind === "recorded") return claimed.result
      if (claimed.kind === "diverged") {
        return stop("toolkit_replay_divergence", `Replayed call ${key} differs from what this turn recorded at that index (${claimed.differs.join(" and ")}: recorded ${claimed.recordedOp}, now ${op}); the replay stopped without running it.`, { key, differs: claimed.differs, recorded_op: claimed.recordedOp, attempted_op: op })
      }
      if (claimed.kind === "pending") {
        return stop("toolkit_replay_pending", `Call ${key} (${op}) was started by an earlier run that never recorded its result; its outcome is unknown, so it was not sent again.`, { key, attempted_op: op })
      }
      let result: unknown
      try {
        result = await dispatch()
      } catch (error) {
        sql.run("DELETE FROM toolkit_replay WHERE replay_key = ? AND state = 'pending'", [key])
        throw error
      }
      sql.run("UPDATE toolkit_replay SET state = 'recorded', result_json = ? WHERE replay_key = ?", [JSON.stringify(result ?? null), key])
      return result
    },
    close() {
      if (closed) return
      closed = true
      connection.close()
    },
  }
}
