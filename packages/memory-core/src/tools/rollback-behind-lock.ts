import { join } from "node:path"

import { existsSync, readFile, rm, writeFile } from "../fs/resilient"
import type { GitMemoryRepo } from "../git"
import type { StrandedGitLockError } from "../git/repo-lock-sweep"
import { restoreWorktreeFromHead } from "../git/worktree-restore"
import { MemoryToolError } from "./tool-errors"

// A write that fails behind a kept git lock must not leave its change behind, or every later write
// hits "uncommitted changes" even after /memory unlock (omo #10199). Whether `git add` already
// staged it depends on WHEN the lock appeared, not on which lock it is, so the decision reads the
// index itself. A staged change cannot be unstaged while index.lock exists; it is recorded inside
// .git and undone before the next memory write, once the lock is gone and HEAD has not moved.

const PENDING_ROLLBACK = "omo-pending-rollback.json"

interface PendingRollback {
  readonly head: string
  readonly paths: readonly string[]
}

function pendingPath(repo: GitMemoryRepo): string {
  return join(repo.dir, ".git", PENDING_ROLLBACK)
}

function indexLockHeld(repo: GitMemoryRepo): boolean {
  return existsSync(join(repo.dir, ".git", "index.lock"))
}

// Porcelain v1 "XY path": a non-blank, non-untracked X column is a staged change.
async function hasStagedChange(repo: GitMemoryRepo, paths: readonly string[]): Promise<boolean> {
  const lines = (await repo.status(paths)).split(/\r?\n/).filter((line) => line.length > 3)
  return lines.some((line) => line[0] !== " " && line[0] !== "?")
}

export async function undoBehindKeptLock(repo: GitMemoryRepo, paths: readonly string[], kept: StrandedGitLockError): Promise<never> {
  let stillStaged = false
  try {
    if (!(await hasStagedChange(repo, paths))) {
      await restoreWorktreeFromHead(repo, paths)
    } else if (!indexLockHeld(repo)) {
      await repo.restorePaths(paths)
    } else {
      await restoreWorktreeFromHead(repo, paths)
      const head = await repo.head()
      if (head === null) throw new Error("the memory repository has no HEAD commit")
      await writeFile(pendingPath(repo), JSON.stringify({ head, paths } satisfies PendingRollback), "utf8")
      stillStaged = true
    }
  } catch (restoreError) {
    const reason = restoreError instanceof Error ? restoreError.message : String(restoreError)
    throw new MemoryToolError(
      `${kept.message}\nThe change this write made could not be undone (${reason}); before retrying, restore or remove: ${paths.join(", ")}`,
      { cause: new AggregateError([kept, restoreError]) },
    )
  }
  if (!stillStaged) throw kept
  throw new MemoryToolError(
    `${kept.message}\nThis write is still staged because the index itself is locked; it is unstaged automatically before the next memory write once that lock is removed.`,
    { cause: kept },
  )
}

function parsePending(raw: string): PendingRollback | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== "object" || value === null) return null
    const { head, paths } = value as { head?: unknown; paths?: unknown }
    if (typeof head !== "string" || !Array.isArray(paths) || !paths.every((path) => typeof path === "string")) return null
    return { head, paths }
  } catch {
    return null
  }
}

// Runs under the memory-write lock, before the clean check. A rollback recorded against another
// HEAD is not ours to apply any more (someone committed since); the clean check then reports
// whatever is staged instead of this code guessing.
export async function applyPendingRollback(repo: GitMemoryRepo): Promise<void> {
  const raw = await readFile(pendingPath(repo), "utf8").catch(() => undefined)
  if (raw === undefined || indexLockHeld(repo)) return
  const pending = parsePending(raw)
  if (pending !== null && (await repo.head()) === pending.head) await repo.restorePaths(pending.paths)
  await rm(pendingPath(repo), { force: true })
}
