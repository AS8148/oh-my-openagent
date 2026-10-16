import { linkSync, readFileSync, statSync } from "node:fs"

import { removeFile, renameIfPresent } from "./session-summary-files"
import { ownerEntryPath, type OwnerRegistryInput, type ProcessOwner } from "./session-summary-owner"
import { readProcessStartTime } from "./session-summary-process-start"

/** How long an entry whose start time cannot be compared still vouches for its owner without a refresh. */
export const OWNER_ENTRY_STALE_MS = 5 * 60_000

/**
 * Only ESRCH (no such process) proves a pid dead. Every other answer, EPERM above all (on win32 `kill(pid, 0)`
 * opens the process, and a process of another user or an elevated one answers access denied), is ambiguous and
 * counts as alive: wrongly keeping a dead owner's files costs a delay, wrongly adopting a live owner's window
 * costs a duplicate.
 */
export function processIsAlive(pid: number, kill: (pid: number) => unknown = (target) => process.kill(target, 0)): boolean {
  try {
    kill(pid)
    return true
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH")
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
  // Removes the entry only while it is still the one judged: a process that took the pid meanwhile keeps its own.
  const forget = (path: string, judged: string | undefined) => {
    if (judged !== undefined) removeIfUnchanged(path, judged, input.owner)
    return false
  }
  return (owner) => {
    if (owner.pid === input.owner.pid && owner.bootId === input.owner.bootId) return true
    const path = ownerEntryPath(input.dir, owner.pid)
    const text = readText(path)
    const entry = parseEntry(text)
    const matches = entry !== undefined && Reflect.get(entry, "bootId") === owner.bootId
    const judged = matches && owner.pid !== input.owner.pid ? text : undefined
    if (!isPidAlive(owner.pid)) return forget(path, judged)
    if (entry === undefined || !matches) return false
    const recorded: unknown = Reflect.get(entry, "startTime")
    const current = typeof recorded === "string" ? startTimeOf(owner.pid) : null
    if (current !== null) return current === recorded || forget(path, judged)
    const heartbeatAt: unknown = Reflect.get(entry, "heartbeatAt")
    const beat = typeof heartbeatAt === "number" ? heartbeatAt : modifiedAt(path)
    return (beat !== undefined && now() - beat <= OWNER_ENTRY_STALE_MS) || forget(path, judged)
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

function parseEntry(text: string | undefined): object | undefined {
  if (text === undefined) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === "object" && value !== null ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Moves the entry aside (an atomic hand-over: a rename takes whichever file is there now), deletes it when it is
 * the one judged, and otherwise links it back unless an even newer entry has been written in the meantime.
 */
function removeIfUnchanged(path: string, judged: string, reader: { readonly pid: number; readonly bootId: string }): void {
  const aside = `${path}.forget-${reader.pid}-${reader.bootId}`
  if (!renameIfPresent(path, aside)) return
  if (readText(aside) !== judged) {
    try {
      linkSync(aside, path)
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
    }
  }
  removeFile(aside)
}

function modifiedAt(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}
