import { execFile } from "node:child_process"
import { join } from "node:path"

import { lstat, readdir, unlink } from "../fs/resilient"
import { isGitLockError, withGitLockRetry } from "./config-lock"

export const GIT_LOCK_SETTLE_MS = 300

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

// A git process killed mid-transaction (a SIGKILLed memory writer, or the exec timeout's kill) can
// never remove the lock files it created. Every later writer then wedges on "...lock: File exists",
// and `git fsck --strict` reports a stranded ref lock as badRefContent (omo #10177). Unlinking a
// lock a LIVE writer holds would publish its torn transaction instead (the facts pipeline writes
// index.lock outside the memory-write lock), so a file is removed only when no process on this
// host has it open - git keeps the lock fd open from create until rename, so an unheld lock has a
// dead creator - and it kept the same inode and mtime across a settle window. Where open handles
// cannot be enumerated (Windows, no lsof) the lock counts as held and the command fails loud.
function hasOpenHolder(path: string): Promise<boolean> {
  if (process.platform === "win32") return Promise.resolve(true)
  return new Promise((resolve) => {
    execFile("lsof", ["-t", "--", path], { windowsHide: true, timeout: 5_000 }, (error, stdout) => {
      if (stdout.trim().length > 0) return resolve(true)
      resolve(!(error !== null && (error as { code?: unknown }).code === 1))
    })
  })
}

export async function sweepStrandedGitLockFiles(dir: string, settleMs = GIT_LOCK_SETTLE_MS): Promise<string[]> {
  const gitDir = join(dir, ".git")
  const candidates = [
    join(gitDir, "index.lock"),
    join(gitDir, "HEAD.lock"),
    join(gitDir, "packed-refs.lock"),
    join(gitDir, "config.lock"),
    ...(await collectRefLockPaths(gitDir)),
  ]
  const idle = new Map<string, { ino: number; mtimeMs: number }>()
  for (const candidate of candidates) {
    const status = await lstat(candidate).catch(() => undefined)
    if (status?.isFile()) idle.set(candidate, { ino: status.ino, mtimeMs: status.mtimeMs })
  }
  if (idle.size === 0) return []
  await new Promise((resolve) => setTimeout(resolve, settleMs))
  const removed: string[] = []
  for (const [candidate, before] of idle) {
    const status = await lstat(candidate).catch(() => undefined)
    if (status === undefined || status.ino !== before.ino || status.mtimeMs !== before.mtimeMs) continue
    if (await hasOpenHolder(candidate)) continue
    try {
      await unlink(candidate)
      removed.push(candidate)
    } catch {
      // A sharing violation (Windows) or a racing remover leaves the file; the retried command fails loud.
    }
  }
  return removed
}

// Preflight for a repo entry point that is about to mutate: cheap existence probe first, so the
// settle window is paid only when a killed writer actually left debris behind.
export async function sweepStrandedGitLockFilesIfPresent(dir: string): Promise<string[]> {
  const gitDir = join(dir, ".git")
  for (const candidate of [join(gitDir, "index.lock"), join(gitDir, "HEAD.lock"), join(gitDir, "packed-refs.lock"), join(gitDir, "config.lock")]) {
    if ((await lstat(candidate).catch(() => undefined))?.isFile()) return sweepStrandedGitLockFiles(dir)
  }
  return (await collectRefLockPaths(gitDir)).at(0) === undefined ? [] : sweepStrandedGitLockFiles(dir)
}

export async function withStrandedGitLockRecovery<T>(dir: string, run: () => Promise<T>): Promise<T> {
  try {
    return await withGitLockRetry(run)
  } catch (error) {
    if (!isGitLockError(error)) throw error
    if ((await sweepStrandedGitLockFiles(dir)).length === 0) throw error
    return run()
  }
}
