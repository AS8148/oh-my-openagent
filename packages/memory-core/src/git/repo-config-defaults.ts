// Local config every memory repository carries. Line endings are pinned because a memory note is
// stored and checked out byte for byte: Git for Windows defaults to core.autocrlf=true, which turned
// LF into CRLF on checkout and CRLF into LF on commit (#11109).
import { readFile } from "../fs/resilient"
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
  if ((await port.configGet("core.autocrlf")) === null) {
    await port.configSet("core.autocrlf", "false")
    await restoreConvertedCheckouts(port.dir, run)
  }
}

// A repository opened before the pin may hold working copies a converting checkout rewrote to CRLF.
// Git's stat cache can still call them clean, so the index entry's eol info finds them. A copy is
// restored only when dropping its CRs gives exactly the committed blob; a real edit is never touched.
async function restoreConvertedCheckouts(dir: string, run: RepoGitRunner): Promise<void> {
  const listing = await run.result(["ls-files", "--eol", "-z"])
  if (listing.code !== 0) return
  const restore: string[] = []
  for (const record of listing.stdout.split("\0")) {
    const tab = record.indexOf("\t")
    if (tab < 0) continue
    const [index, worktree] = record.slice(0, tab).trim().split(/\s+/)
    if (index !== "i/lf" || (worktree !== "w/crlf" && worktree !== "w/mixed")) continue
    const path = record.slice(tab + 1)
    const copy = await readFile(join(dir, path), "utf8").catch(() => undefined)
    if (copy === undefined) continue
    const blob = await run.result(["cat-file", "blob", `:${path}`])
    if (blob.code === 0 && copy.replaceAll("\r\n", "\n") === blob.stdout) restore.push(path)
  }
  if (restore.length > 0) await run.git(["checkout", "--", ...restore])
}
