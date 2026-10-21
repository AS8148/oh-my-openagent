import { closeSync, openSync, unlinkSync } from "node:fs"
import { open } from "node:fs/promises"
import { join } from "node:path"

import { lockName } from "./otlp-spool-names"

/**
 * The exclusive lock for moving one spool file to a name a competitor would not choose (a claim, a
 * lease renewal, a lease reclaim, a dead owner's seal). A rename to DIFFERENT destinations does not
 * pick one winner on Windows: two racing renames of one source can both report success. Creating
 * `<source>.lock` with O_EXCL (CREATE_NEW on Windows) is atomic everywhere, so exactly one competitor
 * moves the file and every other one skips it. A crash while holding a lock leaves it behind; the
 * sweep deletes locks older than the claim lease.
 */

function isBusy(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false
  // A lock another competitor is deleting stays "delete pending" on Windows, and opening it fails EPERM.
  return error.code === "EEXIST" || error.code === "ENOENT" || (error.code === "EPERM" && process.platform === "win32")
}

export function tryLockSync(dir: string, source: string): boolean {
  try {
    closeSync(openSync(join(dir, lockName(source)), "wx"))
    return true
  } catch (error) {
    if (isBusy(error)) return false
    throw error
  }
}

/** Off the event loop, like the claim rename it guards: a stalled synchronous call would hold every timer. */
export async function tryLock(dir: string, source: string): Promise<boolean> {
  try {
    await (await open(join(dir, lockName(source)), "wx")).close()
    return true
  } catch (error) {
    if (isBusy(error)) return false
    throw error
  }
}

export function unlock(dir: string, source: string): void {
  try {
    unlinkSync(join(dir, lockName(source)))
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
  }
}
