import { hostname } from "node:os"
import { join, resolve } from "node:path"

import { lstat, readFile, unlink, type BigIntStats } from "../fs/resilient"
import { getPidLiveness, parseLockRecord } from "../locks"
import { findOpenFileHolderPids } from "./open-file-holders"
import { findProcessesWorkingIn } from "./repo-in-use"
import { presentLockFiles, writerLockPathForRepo } from "./repo-lock-sweep"

// The manual way out of a kept stranded git lock (omo #10199). It re-checks ONE lock with the
// sweep's own evidence and never decides on its own: a visible live holder, repository user or
// memory writer refuses; anything else needs the user's confirmation, and an unknown answer is
// reported as unknown rather than read as "nobody".

export interface UnlockScans {
  readonly findHolders: (lockPath: string) => Promise<readonly number[] | null>
  readonly findRepoUsers: (repoDir: string) => Promise<readonly number[] | null>
}

const PRODUCTION_SCANS: UnlockScans = {
  findHolders: (lockPath) => findOpenFileHolderPids(lockPath),
  findRepoUsers: (repoDir) => findProcessesWorkingIn(repoDir),
}

export interface UnlockFindings {
  readonly kind: "found"
  readonly lockPath: string
  readonly identity: string
  readonly holders: readonly number[] | null
  readonly repoUsers: readonly number[] | null
  readonly writerPid: number | null
  readonly verdict: "refuse" | "confirm"
}

export type UnlockInspection = { readonly kind: "not-a-git-lock" } | { readonly kind: "missing" } | UnlockFindings

export type UnlockOutcome =
  | { readonly kind: "removed"; readonly lockPath: string }
  | { readonly kind: "refused"; readonly inspection: UnlockFindings }
  | { readonly kind: "changed"; readonly lockPath: string }
  | { readonly kind: "missing" | "not-a-git-lock" }
  | { readonly kind: "unlink-failed"; readonly lockPath: string; readonly message: string }

async function liveWriterPid(repoDir: string): Promise<number | null> {
  const writerLockPath = writerLockPathForRepo(repoDir)
  if (writerLockPath === null) return null
  const raw = await readFile(writerLockPath, "utf8").catch(() => undefined)
  const record = raw === undefined ? null : parseLockRecord(raw)
  if (record === null || record.hostname !== hostname() || record.pid === process.pid) return null
  return getPidLiveness(record.pid) === "alive" ? record.pid : null
}

// On ext4 a removed file's inode is reused at once and the coarse timestamp clock can repeat, so
// inode plus mtime cannot tell a re-taken lock from the inspected one; size and the nanosecond
// change and birth times narrow it to a replacement of the same size within one clock tick.
function fileIdentity(status: BigIntStats): string {
  return [status.dev, status.ino, status.size, status.mtimeNs, status.ctimeNs, status.birthtimeNs].join(":")
}

export async function inspectStrandedGitLock(repoDir: string, lockPath: string, scans: UnlockScans = PRODUCTION_SCANS): Promise<UnlockInspection> {
  const target = resolve(lockPath)
  const present = await presentLockFiles(join(resolve(repoDir), ".git"))
  if (!present.has(target)) {
    const status = await lstat(target).catch(() => undefined)
    return status === undefined && target.startsWith(join(resolve(repoDir), ".git")) && target.endsWith(".lock")
      ? { kind: "missing" }
      : { kind: "not-a-git-lock" }
  }
  const status = await lstat(target, { bigint: true }).catch(() => undefined)
  if (status === undefined) return { kind: "missing" }
  const [holders, repoUsers, writerPid] = await Promise.all([
    scans.findHolders(target),
    scans.findRepoUsers(repoDir),
    liveWriterPid(repoDir),
  ])
  const visiblyLive = (holders?.length ?? 0) > 0 || (repoUsers?.length ?? 0) > 0 || writerPid !== null
  return {
    kind: "found",
    lockPath: target,
    identity: fileIdentity(status),
    holders,
    repoUsers,
    writerPid,
    verdict: visiblyLive ? "refuse" : "confirm",
  }
}

// Invariant: the unlink follows a fresh inspection that still allows it and still sees the same
// file (inode and mtime); a lock re-taken by a new git process after the user confirmed is a
// different file and is never deleted.
export async function unlockStrandedGitLock(repoDir: string, confirmed: UnlockFindings, scans: UnlockScans = PRODUCTION_SCANS): Promise<UnlockOutcome> {
  const fresh = await inspectStrandedGitLock(repoDir, confirmed.lockPath, scans)
  if (fresh.kind !== "found") return { kind: fresh.kind }
  if (fresh.identity !== confirmed.identity) return { kind: "changed", lockPath: fresh.lockPath }
  if (fresh.verdict === "refuse") return { kind: "refused", inspection: fresh }
  try {
    await unlink(fresh.lockPath)
    return { kind: "removed", lockPath: fresh.lockPath }
  } catch (error) {
    return { kind: "unlink-failed", lockPath: fresh.lockPath, message: error instanceof Error ? error.message : String(error) }
  }
}
