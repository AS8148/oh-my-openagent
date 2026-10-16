import { lstatSync, readdirSync, realpathSync, rmdirSync, type Stats, unlinkSync } from "node:fs"
import { isAbsolute, join, relative } from "node:path"

import { isSpoolFileName, QUARANTINE_DIR } from "./otlp-spool-dir"
import type { TelemetrySpoolEntryKind } from "./types"

/** `refused`: the directory failed verification and nothing was deleted. */
export type PurgeOutcome = "purged" | "absent" | "refused"

/** Test seams for what an unprivileged test cannot stage: an entry swapped mid-purge, a file of another user. */
export type PurgeSeams = {
  readonly unlink?: (path: string) => void
  readonly ownerOf?: (path: string, uid: number) => number
}

type Owner = (path: string, stat: Stats) => boolean

function hasCode(error: unknown, codes: readonly string[]): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string" && codes.includes(error.code)
}

/** False only where uids exist (not on Windows) and the entry belongs to someone else. */
function ownerCheck(ownerOf: PurgeSeams["ownerOf"]): Owner {
  return (path, stat) => typeof process.getuid !== "function" || (ownerOf ? ownerOf(path, stat.uid) : stat.uid) === process.getuid()
}

function realDirectory(path: string, owned: Owner): "dir" | "missing" | "other" {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink() && owned(path, stat) ? "dir" : "other"
  } catch (error) {
    if (hasCode(error, ["ENOENT"])) return "missing"
    throw error
  }
}

function isStrictlyInside(root: string, dir: string): boolean {
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch (error) {
    if (hasCode(error, ["ENOENT", "ENOTDIR"])) return false
    throw error
  }
  const rel = relative(realRoot, realpathSync(dir))
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

function skipKind(path: string, owned: Owner): TelemetrySpoolEntryKind | "gone" | null {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return "symlink"
    if (stat.isDirectory()) return "directory"
    if (!stat.isFile()) return "other"
    return owned(path, stat) ? null : "foreign_owner"
  } catch (error) {
    if (hasCode(error, ["ENOENT"])) return "gone"
    throw error
  }
}

type Sweep = { readonly owned: Owner; readonly unlink: (path: string) => void; readonly onSkipped: (kind: TelemetrySpoolEntryKind) => void }

function unlinkOwned(dir: string, names: readonly string[], sweep: Sweep): void {
  for (const name of names) {
    if (!isSpoolFileName(name)) continue
    const path = join(dir, name)
    const skip = skipKind(path, sweep.owned)
    if (skip === "gone") continue
    if (skip !== null) {
      sweep.onSkipped(skip)
      continue
    }
    try {
      sweep.unlink(path)
    } catch (error) {
      if (hasCode(error, ["EISDIR", "EPERM", "ENOTDIR"])) sweep.onSkipped("other")
      else if (!hasCode(error, ["ENOENT"])) throw error
    }
  }
}

function removeIfEmpty(dir: string): void {
  try {
    rmdirSync(dir)
  } catch (error) {
    if (!hasCode(error, ["ENOENT", "ENOTEMPTY", "EEXIST"])) throw error
  }
}

/**
 * The opt-out purge. An opt-out is the user's decision for the product, so it covers what earlier
 * consented runs and other live processes left: sealed batches, in-flight claims, every process's
 * WAL file and the quarantine. It deletes ONLY names the spool itself creates (`isSpoolFileName`,
 * derived from the spool's own name builders), never a recursive delete, so a caller that passes a
 * shared directory loses nothing but spool files. Of those names it deletes only regular files owned
 * by the current user; a spool-named directory, symlink, special file or file of another user is
 * left in place, reported through `onSkipped` by kind (never by path), and the purge goes on.
 *
 * It runs only inside a verified spool directory: the directory (and the quarantine inside it) must
 * be a real directory owned by the current user, not a symlink or junction, and its real path must
 * lie strictly below the real path of `root`. Anything else is `refused` with no deletion.
 *
 * Race handling with other live processes of the same product:
 * - Each file is removed on its own and ENOENT is ignored, so a file another process renames or
 *   deletes in the meantime (a claim, a send that completed) is never an error.
 * - A consented process keeps an open file descriptor on its unlinked WAL file; its next seal finds
 *   the name gone and drops those records quietly (the purge already covered them), and its next
 *   append starts a new file. Its in-flight claim disappears too: the send's delete or release then
 *   finds nothing, which is also quiet.
 * - The directories are removed last and only when empty: a file a consented process created after
 *   the listing (or a foreign file) leaves the directory in place.
 * - An entry swapped for a directory (or into one) between its check and its unlink fails with
 *   EISDIR, EPERM or ENOTDIR; it is skipped and reported as `other`, and the sweep goes on.
 */
export function purgeSpool(
  dir: string,
  root: string,
  onSkipped: (kind: TelemetrySpoolEntryKind) => void,
  seams: PurgeSeams = {},
): PurgeOutcome {
  const owned = ownerCheck(seams.ownerOf)
  const kind = realDirectory(dir, owned)
  if (kind === "missing") return "absent"
  if (kind === "other" || !isStrictlyInside(root, dir)) return "refused"
  const quarantine = join(dir, QUARANTINE_DIR)
  if (realDirectory(quarantine, owned) === "other") return "refused"
  const sweep: Sweep = { owned, unlink: seams.unlink ?? unlinkSync, onSkipped }
  unlinkOwned(dir, readdirSync(dir), sweep)
  try {
    unlinkOwned(quarantine, readdirSync(quarantine), sweep)
  } catch (error) {
    if (!hasCode(error, ["ENOENT"])) throw error
  }
  removeIfEmpty(quarantine)
  removeIfEmpty(dir)
  return "purged"
}
