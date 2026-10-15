import { hostname } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

import { AGENTS_DIRNAME, REPO_DIRNAME, RUNTIME_DIRNAME } from "../identity"

import { lstat, readFile, readdir, unlink } from "../fs/resilient"
import { memoryWriterLockPath, parseLockRecord } from "../locks"
import { isLockOwnerProvenDead } from "../locks/acquire"
import { provenDeadTakeoverFor } from "../locks/proven-dead-takeovers"
import { isGitLockError, withGitLockRetry } from "./config-lock"
import { GitError } from "./errors"
import { hasOpenFileHolder } from "./open-file-holders"

// Settle window between observing an idle lock candidate and re-checking it. The crash-
// consistency fixture child shortens its OWN process's window through the
// OMO_TEST_GIT_LOCK_SETTLE_MS env escape hatch, applied once at module init; production callers
// never set it, and the override stays process-local.
function envSettleOverride(): number | undefined {
  const raw = process.env.OMO_TEST_GIT_LOCK_SETTLE_MS
  if (raw === undefined) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
}
export const GIT_LOCK_SETTLE_MS = envSettleOverride() ?? 300

export interface GitLockSweepReport {
  readonly removed: readonly string[]
  readonly keptUnknownOwner: readonly string[]
}

// A stranded git-internal lock whose owner cannot be proven dead is reported, never removed: the
// file may belong to a LIVE writer whose fd is already closed (omo #10199 review HIGH 1).
export class StrandedGitLockError extends GitError {
  constructor(readonly paths: readonly string[]) {
    super(
      `Stranded git lock file(s) block the memory write and their previous owner cannot be proven dead: ${paths.join(", ")}. ` +
      "Confirm no git process is operating on this repository, remove the lock files, then retry.",
    )
  }
}

async function collectRefLockPaths(gitDir: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const full = join(dir, name)
      const status = await lstat(full).catch(() => undefined)
      if (status === undefined) continue
      if (status.isDirectory()) await walk(full)
      else if (name.endsWith(".lock")) found.push(full)
    }
  }
  await walk(join(gitDir, "refs"))
  return found
}

type LockSnapshot = ReadonlyMap<string, { readonly ino: number; readonly mtimeMs: number }>

async function presentLockFiles(gitDir: string): Promise<LockSnapshot> {
  const candidates = [
    join(gitDir, "index.lock"),
    join(gitDir, "HEAD.lock"),
    join(gitDir, "packed-refs.lock"),
    join(gitDir, "config.lock"),
    ...(await collectRefLockPaths(gitDir)),
  ]
  const present = new Map<string, { ino: number; mtimeMs: number }>()
  for (const candidate of candidates) {
    const status = await lstat(candidate).catch(() => undefined)
    if (status?.isFile()) present.set(candidate, { ino: status.ino, mtimeMs: status.mtimeMs })
  }
  return present
}

// After authorization, a lock is removable only if it kept its inode and mtime across the settle
// window AND no process holds it open: belt and braces on top of the ownership proof.
async function settledUnheld(present: LockSnapshot, settleMs: number): Promise<string[]> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, settleMs))
  const removable: string[] = []
  for (const [candidate, before] of present) {
    const status = await lstat(candidate).catch(() => undefined)
    if (status === undefined || status.ino !== before.ino || status.mtimeMs !== before.mtimeMs) continue
    if (await hasOpenFileHolder(candidate)) continue
    removable.push(candidate)
  }
  return removable
}

// The identity layout (identity/layout.ts) pins the memory-write lock next to the repo:
// <root>/agents/<id>/repo and <root>/agents/<id>/runtime/locks. A repo outside that layout has
// no writer lock to authorize with, so it can never be swept.
function writerLockPathForRepo(repoDir: string): string | null {
  const resolved = resolve(repoDir)
  if (basename(resolved) !== REPO_DIRNAME || basename(dirname(dirname(resolved))) !== AGENTS_DIRNAME) return null
  return memoryWriterLockPath(join(dirname(resolved), RUNTIME_DIRNAME, "locks"))
}

// The sweep's contract changed with omo #10199 review HIGH 1: a git process killed
// mid-transaction strands lock files it can never remove, but so does a LIVE writer in the
// windows where git already closed the lock fd (commit's prepare_index, the files ref backend's
// post-write close). Open handles and age can never distinguish the two, so reclamation is tied
// to ownership: the sweep runs only while the caller holds the identity's memory-write lock, and
// only when the lock protocol proved the recorded previous owner dead (pid + start identity;
// provenDeadTakeoverFor keeps that proof across the republish). Unknown ownership keeps the lock
// and the caller surfaces it through StrandedGitLockError instead of deleting on no evidence.
// Both gates must hold, in order: (1) THIS process holds the identity's memory-write lock right
// now, and (2) the lock protocol proved the previous owner dead when this process took it over,
// re-verified here so a pid recycled since the takeover cannot pass.
async function authorizedToReclaim(repoDir: string): Promise<boolean> {
  const writerLockPath = writerLockPathForRepo(repoDir)
  if (writerLockPath === null) return false
  const raw = await readFile(writerLockPath, "utf8").catch(() => undefined)
  const current = raw === undefined ? null : parseLockRecord(raw)
  if (current === null || current.pid !== process.pid || current.hostname !== hostname()) return false
  const previous = provenDeadTakeoverFor(writerLockPath)
  return previous !== undefined && (await isLockOwnerProvenDead(previous))
}

export async function sweepStrandedGitLockFiles(dir: string, settleMs = GIT_LOCK_SETTLE_MS): Promise<GitLockSweepReport> {
  const present = await presentLockFiles(join(dir, ".git"))
  if (present.size === 0) return { removed: [], keptUnknownOwner: [] }
  if (!(await authorizedToReclaim(dir))) return { removed: [], keptUnknownOwner: [...present.keys()] }

  const removable = new Set(await settledUnheld(present, settleMs))
  const removed: string[] = []
  const kept = [...present.keys()].filter((candidate) => !removable.has(candidate))
  for (const candidate of removable) {
    try {
      await unlink(candidate)
      removed.push(candidate)
    } catch {
      // A sharing violation (Windows) or a racing remover leaves the file; the retried command
      // fails loud, or the caller reports what is left through StrandedGitLockError.
      kept.push(candidate)
    }
  }
  return { removed, keptUnknownOwner: kept }
}

export async function withStrandedGitLockRecovery<T>(dir: string, run: () => Promise<T>): Promise<T> {
  try {
    return await withGitLockRetry(run)
  } catch (error) {
    if (!isGitLockError(error)) throw error
    const report = await sweepStrandedGitLockFiles(dir)
    if (report.removed.length === 0) {
      if (report.keptUnknownOwner.length > 0) throw new StrandedGitLockError(report.keptUnknownOwner)
      throw error
    }
    return run()
  }
}
