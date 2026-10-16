import { statSync } from "node:fs"

import { readJson, removeFile } from "./session-summary-files"
import { ownerEntryPath, type OwnerRegistryInput, type ProcessOwner } from "./session-summary-owner"
import { readProcessStartTime } from "./session-summary-process-start"

/** How long an entry whose start time cannot be compared still vouches for its owner without a refresh. */
export const OWNER_ENTRY_STALE_MS = 5 * 60_000

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

/**
 * An owner is alive only while its pid is alive, the entry names the same boot id, AND the pid still names
 * the process that wrote the entry (same start time). A SIGKILLed owner never removes its entry, so without
 * the start time an unrelated process that later reuses the pid would keep the dead owner's files until it
 * exits; a later OmO process on the pid writes another boot id.
 *
 * When the start time cannot be compared (an entry from an older version without one, or a platform or
 * moment where the probe reads nothing) the entry's heartbeat decides: alive while it is fresher than
 * `OWNER_ENTRY_STALE_MS`, dead after. Owners refresh it on every window write, at most once a minute, so a
 * live owner on such a platform stays alive while a killed one ages out. An entry without a heartbeat (older
 * version) is aged by its file mtime. Only recovery asks, so this ships in the recovery sidecar.
 */
export function createOwnerLiveness(input: OwnerRegistryInput & {
  readonly isPidAlive?: (pid: number) => boolean
}): (owner: ProcessOwner) => boolean {
  const isPidAlive = input.isPidAlive ?? processIsAlive
  const startTimeOf = input.processStartTime ?? readProcessStartTime
  const now = input.now ?? Date.now
  const forget = (pid: number) => {
    if (pid !== input.owner.pid) removeFile(ownerEntryPath(input.dir, pid))
    return false
  }
  return (owner) => {
    if (owner.pid === input.owner.pid && owner.bootId === input.owner.bootId) return true
    if (!isPidAlive(owner.pid)) return forget(owner.pid)
    const path = ownerEntryPath(input.dir, owner.pid)
    const entry = readJson(path)
    if (typeof entry !== "object" || entry === null || Reflect.get(entry, "bootId") !== owner.bootId) return false
    const recorded: unknown = Reflect.get(entry, "startTime")
    const current = typeof recorded === "string" ? startTimeOf(owner.pid) : null
    if (current !== null) return current === recorded || forget(owner.pid)
    const heartbeatAt: unknown = Reflect.get(entry, "heartbeatAt")
    const beat = typeof heartbeatAt === "number" ? heartbeatAt : modifiedAt(path)
    return (beat !== undefined && now() - beat <= OWNER_ENTRY_STALE_MS) || forget(owner.pid)
  }
}

function modifiedAt(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}
