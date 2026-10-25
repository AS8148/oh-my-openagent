import { randomBytes } from "node:crypto"
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { parseTaskId } from "../state"
import type { TaskId, TaskRecord } from "../state"
import { toStorableTaskRecord } from "./storable-record"

export type WriteRecordMode = "create" | "replace"

export type RecordWriteDeps = {
  readonly rename?: typeof renameSync
  readonly sleep?: (ms: number) => void
}

// Windows may refuse the rename with a sharing violation while Defender, an indexer, or another
// senpi process still holds the record or its temp file (#8050, #11269). Like #9491's memory
// writer and graceful-fs, give a passing hold time to clear. Exponential delays total 1,270 ms;
// the old 8 x 5 ms budget expired during ordinary reader/indexer holds. Other errors fail at once.
const WINDOWS_RENAME_DELAYS_MS: readonly number[] = [10, 20, 40, 80, 160, 320, 640]
const WINDOWS_TRANSIENT_CODES: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "EACCES"])
const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))

export class TaskRecordCollisionError extends Error {
  readonly taskId: TaskId
  readonly path: string

  constructor(input: { readonly taskId: TaskId; readonly path: string }) {
    super(`Task record already exists: ${input.taskId}`)
    this.name = "TaskRecordCollisionError"
    this.taskId = input.taskId
    this.path = input.path
  }
}

export function writeRecord(path: string, record: TaskRecord, mode: WriteRecordMode, platform: NodeJS.Platform, deps: RecordWriteDeps = {}): void {
  mkdirSync(dirname(path), { recursive: true })
  const payload = JSON.stringify(toStorableTaskRecord(record))
  if (mode === "create") {
    try {
      writeFileSync(path, payload, { encoding: "utf8", flag: "wx" })
      return
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new TaskRecordCollisionError({ taskId: parseTaskId(record.task_id), path })
      }
      throw error
    }
  }

  atomicReplace(path, payload, platform, deps)
}

// Shared by task records and plain workpool data. Callers own the short record lock.
export function atomicReplace(path: string, payload: string, platform: NodeJS.Platform = process.platform, deps: RecordWriteDeps = {}): void {
  mkdirSync(dirname(path), { recursive: true })
  // pid + random segment: two writers in one process (or a pid reused across a crash) never share
  // a temp name, and the finally leaves nothing behind when the rename is refused.
  const tmpPath = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  try {
    writeFileSync(tmpPath, payload, "utf8")
    renameWithWindowsRetry(tmpPath, path, platform, deps)
  } finally {
    rmSync(tmpPath, { force: true })
  }
}

function renameWithWindowsRetry(from: string, to: string, platform: NodeJS.Platform, deps: RecordWriteDeps): void {
  const rename = deps.rename ?? renameSync
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(from, to)
      return
    } catch (error) {
      const delay = WINDOWS_RENAME_DELAYS_MS[attempt]
      if (platform !== "win32" || delay === undefined || !isTransientWindowsError(error)) throw error
      if (deps.sleep !== undefined) deps.sleep(delay)
      else Atomics.wait(sleeper, 0, 0, delay)
    }
  }
}

function isTransientWindowsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string" && WINDOWS_TRANSIENT_CODES.has(error.code)
}
