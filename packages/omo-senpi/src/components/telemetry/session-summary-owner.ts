import { randomUUID } from "node:crypto"
import { statSync } from "node:fs"
import { join } from "node:path"

import { readJson, removeFile, writeJsonAtomic } from "./session-summary-files"
import { readProcessStartTime } from "./session-summary-process-start"

export type ProcessOwner = { readonly pid: number; readonly bootId: string }

/** Random per loaded module instance, so a reused pid never passes for the process that wrote a file. */
export const PROCESS_BOOT_ID = randomUUID()

export function currentProcessOwner(): ProcessOwner {
  return { pid: process.pid, bootId: PROCESS_BOOT_ID }
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

export type OwnerRegistry = {
  /** Writes (or refreshes) this process's entry: boot id, start time and heartbeat. */
  readonly register: () => void
  readonly isAlive: (owner: ProcessOwner) => boolean
}

/** How long an entry whose start time cannot be compared still vouches for its owner without a refresh. */
export const OWNER_ENTRY_STALE_MS = 5 * 60_000

/**
 * `owners/<pid>.json` holds the boot id, the process start time and a heartbeat of the OmO process that
 * wrote it. An owner is alive only while its pid is alive, the entry names the same boot id, AND the pid
 * still names the process that wrote the entry (same start time). A SIGKILLed owner never removes its
 * entry, so without the start time an unrelated process that later reuses the pid would keep the dead
 * owner's files until it exits; a later OmO process on the pid writes another boot id.
 *
 * The start time recorded is the WRITING process's (`processStartTime(process.pid)`), because only the
 * owner itself writes its entry. When it cannot be compared (an entry from an older version without one, or
 * a platform or moment where the probe reads nothing) the entry's heartbeat decides: alive while it is
 * fresher than `OWNER_ENTRY_STALE_MS`, dead after. Owners refresh it on every window write, at most once a
 * minute, so a live owner on such a platform stays alive while a killed one ages out. An entry without a
 * heartbeat (older version) is aged by its file mtime.
 */
export function createOwnerRegistry(input: {
  readonly dir: string
  readonly owner: ProcessOwner
  readonly isPidAlive: (pid: number) => boolean
  /** Start-time probe; defaults to the real one. Injected by tests that simulate pid reuse. */
  readonly processStartTime?: (pid: number) => string | null
  readonly now?: () => number
}): OwnerRegistry {
  const pathOf = (pid: number) => join(input.dir, "owners", `${pid}.json`)
  const startTimeOf = input.processStartTime ?? readProcessStartTime
  const now = input.now ?? Date.now
  let ownStartTime: string | null | undefined
  const forget = (pid: number) => {
    if (pid !== input.owner.pid) removeFile(pathOf(pid))
    return false
  }
  return {
    register() {
      ownStartTime ??= startTimeOf(process.pid)
      const entry = { pid: input.owner.pid, bootId: input.owner.bootId, startTime: ownStartTime, heartbeatAt: now() }
      writeJsonAtomic(pathOf(input.owner.pid), entry, input.owner)
    },
    isAlive(owner) {
      if (owner.pid === input.owner.pid && owner.bootId === input.owner.bootId) return true
      if (!input.isPidAlive(owner.pid)) return forget(owner.pid)
      const path = pathOf(owner.pid)
      const entry = readJson(path)
      if (typeof entry !== "object" || entry === null || Reflect.get(entry, "bootId") !== owner.bootId) return false
      const recorded: unknown = Reflect.get(entry, "startTime")
      const current = typeof recorded === "string" ? startTimeOf(owner.pid) : null
      if (current !== null) return current === recorded || forget(owner.pid)
      const heartbeatAt: unknown = Reflect.get(entry, "heartbeatAt")
      const beat = typeof heartbeatAt === "number" ? heartbeatAt : modifiedAt(path)
      return (beat !== undefined && now() - beat <= OWNER_ENTRY_STALE_MS) || forget(owner.pid)
    },
  }
}

function modifiedAt(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

export function parseOwner(value: unknown): ProcessOwner | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const pid: unknown = Reflect.get(value, "pid")
  const bootId: unknown = Reflect.get(value, "bootId")
  return typeof pid === "number" && Number.isInteger(pid) && typeof bootId === "string" && bootId.length > 0
    ? { pid, bootId }
    : undefined
}
