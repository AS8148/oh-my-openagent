// Local config every memory repository carries. Line endings are pinned because a memory note is
// stored and checked out byte for byte: Git for Windows defaults to core.autocrlf=true, which turned
// LF into CRLF on checkout and CRLF into LF on commit (#11109).
import { readFile, rename, writeFile } from "../fs/resilient"
import { join } from "node:path"

import type { GitExecResult } from "./exec"

export interface RepoConfigTarget {
  readonly dir: string
  readonly agentId: string
  configGet(key: string): Promise<string | null>
  configSet(key: string, value: string): Promise<void>
}

export interface RepoGitRunner {
  git(argv: readonly string[]): Promise<GitExecResult>
  result(argv: readonly string[]): Promise<GitExecResult>
}

export async function ensureRepoConfigDefaults(
  port: RepoConfigTarget, run: RepoGitRunner, authorName: string,
): Promise<void> {
  if ((await port.configGet("omo.agentId")) !== port.agentId) await port.configSet("omo.agentId", port.agentId)
  if (!(await port.configGet("user.email"))) await port.configSet("user.email", `${port.agentId}@omo.local`)
  if (!(await port.configGet("user.name"))) await port.configSet("user.name", authorName)
  if ((await port.configGet("commit.gpgsign")) === null) await port.configSet("commit.gpgsign", "false")
  if ((await port.configGet("gc.auto")) === null) await port.configSet("gc.auto", "0")
  // Forced, not defaulted: a memory repository is machine-owned and must keep note bytes exactly.
  // The key is written only after the repair succeeds, so a failed repair runs again on the next open.
  if ((await port.configGet("core.autocrlf")) !== "false") {
    await restoreConvertedCheckouts(port.dir, run)
    await port.configSet("core.autocrlf", "false")
  }
}

// A repository opened before the pin may hold working copies a converting checkout rewrote to CRLF,
// and git's stat cache can still call them clean, so `git checkout` would skip them. A copy is
// rewritten only when dropping its CRs gives exactly the committed bytes; a real edit is never touched.
async function restoreConvertedCheckouts(dir: string, run: RepoGitRunner): Promise<void> {
  const listing = await run.git(["ls-files", "--eol", "-z"])
  for (const record of listing.stdout.split("\0")) {
    const tab = record.indexOf("\t")
    if (tab < 0) continue
    const [index, worktree] = record.slice(0, tab).trim().split(/\s+/)
    if (index !== "i/lf" || (worktree !== "w/crlf" && worktree !== "w/mixed")) continue
    const path = record.slice(tab + 1)
    const copy = await readFile(join(dir, path)).catch(() => undefined)
    const bytes = copy === undefined ? undefined : dropCarriageReturnsBeforeLineFeeds(copy)
    if (bytes === undefined || !(await matchesIndexBlob(run, path, bytes))) continue
    await writeFile(`${join(dir, path)}.omo-eol.tmp`, bytes)
    await rename(`${join(dir, path)}.omo-eol.tmp`, join(dir, path))
  }
  await reindexUnchangedCopies(dir, run)
}

// The index still caches each rewritten copy's CRLF size, and git calls a size change modified
// without reading the file. Re-hashing a path whose bytes equal its index blob stages that same
// blob, so it only refreshes the cache. A run that failed here is finished by the next open.
async function reindexUnchangedCopies(dir: string, run: RepoGitRunner): Promise<void> {
  const changed = (await run.git(["diff-files", "--name-only", "-z"])).stdout.split("\0").filter(Boolean)
  const unchanged: string[] = []
  for (const path of changed) {
    const copy = await readFile(join(dir, path)).catch(() => undefined)
    if (copy !== undefined && (await matchesIndexBlob(run, path, copy))) unchanged.push(path)
  }
  if (unchanged.length > 0) await run.git(["-c", "core.autocrlf=false", "update-index", "-q", "--", ...unchanged])
}

// Byte comparison: a non-UTF-8 blob does not survive the string round trip, so it never matches.
async function matchesIndexBlob(run: RepoGitRunner, path: string, bytes: Buffer): Promise<boolean> {
  const blob = await run.git(["cat-file", "blob", `:${path}`])
  return Buffer.from(blob.stdout, "utf8").equals(bytes)
}

function dropCarriageReturnsBeforeLineFeeds(bytes: Buffer): Buffer {
  const out = Buffer.allocUnsafe(bytes.length)
  let length = 0
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) continue
    out[length] = bytes[index] ?? 0
    length += 1
  }
  return out.subarray(0, length)
}
