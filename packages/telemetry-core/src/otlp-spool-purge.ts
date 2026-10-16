import { lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

import { isSpoolFileName, QUARANTINE_DIR } from "./otlp-spool-dir"

/** `refused`: the directory failed verification and nothing was deleted. */
export type PurgeOutcome = "purged" | "absent" | "refused"

function hasCode(error: unknown, codes: readonly string[]): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string" && codes.includes(error.code)
}

function realDirectory(path: string): "dir" | "missing" | "other" {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink() ? "dir" : "other"
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

function unlinkOwned(dir: string, names: readonly string[]): void {
  for (const name of names) {
    if (!isSpoolFileName(name)) continue
    try {
      unlinkSync(join(dir, name))
    } catch (error) {
      if (!hasCode(error, ["ENOENT"])) throw error
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
 * shared directory loses nothing but spool files.
 *
 * It runs only inside a verified spool directory: the directory (and the quarantine inside it) must
 * be a real directory, not a symlink or junction, and its real path must lie strictly below the real
 * path of `root` (default: the spool directory's parent). Anything else is `refused` with no deletion.
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
 */
export function purgeSpool(dir: string, root: string = dirname(resolve(dir))): PurgeOutcome {
  const kind = realDirectory(dir)
  if (kind === "missing") return "absent"
  if (kind === "other" || !isStrictlyInside(root, dir)) return "refused"
  const quarantine = join(dir, QUARANTINE_DIR)
  if (realDirectory(quarantine) === "other") return "refused"
  unlinkOwned(dir, readdirSync(dir))
  try {
    unlinkOwned(quarantine, readdirSync(quarantine))
  } catch (error) {
    if (!hasCode(error, ["ENOENT"])) throw error
  }
  removeIfEmpty(quarantine)
  removeIfEmpty(dir)
  return "purged"
}
