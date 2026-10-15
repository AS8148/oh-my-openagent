import { randomUUID } from "node:crypto"
import { join } from "node:path"

import { readJson, removeFile, writeJsonAtomic } from "./session-summary-files"

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
  readonly register: () => void
  readonly isAlive: (owner: ProcessOwner) => boolean
}

/**
 * `owners/<pid>.json` holds the boot id of the OmO process that currently has that pid. An owner is alive
 * only while its pid is alive AND the registry names the same boot id: a pid reused by an unrelated
 * process (no entry) or by a later OmO process (another boot id) does not keep a dead owner's files.
 */
export function createOwnerRegistry(input: {
  readonly dir: string
  readonly owner: ProcessOwner
  readonly isPidAlive: (pid: number) => boolean
}): OwnerRegistry {
  const pathOf = (pid: number) => join(input.dir, "owners", `${pid}.json`)
  return {
    register() {
      writeJsonAtomic(pathOf(input.owner.pid), { pid: input.owner.pid, bootId: input.owner.bootId }, input.owner)
    },
    isAlive(owner) {
      if (owner.pid === input.owner.pid && owner.bootId === input.owner.bootId) return true
      if (!input.isPidAlive(owner.pid)) {
        if (owner.pid !== input.owner.pid) removeFile(pathOf(owner.pid))
        return false
      }
      const entry = readJson(pathOf(owner.pid))
      return typeof entry === "object" && entry !== null && Reflect.get(entry, "bootId") === owner.bootId
    },
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
