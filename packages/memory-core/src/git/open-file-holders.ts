import { execFile } from "node:child_process"
import { join } from "node:path"

import { readdir, readlink, realpath, stat } from "../fs/resilient"

import { GitError } from "./errors"

// omo #10199 (Linux defect): the stranded-git-lock sweep must answer "does any live process hold
// this lock file open?" on every supported platform. The first cut asked lsof, but minimal Linux
// installs and containers ship no lsof, the spawn error counted as "held", and crash recovery
// silently stopped reclaiming anything there (the #10177 takeover tests failed in an lsof-less
// Linux container). Holder detection now lives behind ONE production helper with one semantics: a
// pid list when the answer is known, null when it cannot be determined, and every caller fails
// closed (indeterminate == held), matching the sweep's authorization-first design.
//
// Platform strategy:
// - linux: scan /proc/<pid>/fd (below). No external binary, nothing to install.
// - other posix (macOS): lsof, guaranteed present there. Its exit-1-with-empty-stdout is the only
//   "no holders" answer; any other failure is indeterminate (review LOW 5).
// - win32: no source at all -> indeterminate -> held (the pre-existing conservative answer).
// "Held only when neither source works": on linux an UNAVAILABLE /proc falls through to lsof as a
// last resort; an INDETERMINATE /proc scan (a same-user process would not show its fds) does NOT
// fall through, because lsof reads the same /proc with the same euid and an empty answer from it
// would be false confidence.

// The conservative rule for fd dirs this process cannot read, e.g. another user's processes. A
// SAME-uid process whose fd dir is unreadable (hidepid, SELinux, ptrace_scope) makes the whole
// scan indeterminate -> held, because a same-uid git process is exactly the realistic creator and
// holder of a lock inside this user's memory repo. Another uid's unreadable fd dir is safe to
// skip: it is the same blind spot non-root lsof has on the same machine (lsof reads the same
// /proc with the same euid), a foreign-uid process cannot have created a lock inside this user's
// memory home (it has no write permission there), and a foreign read-only open survives an unlink
// harmlessly. Parity with the shipped macOS path, never weaker.
export function unreadableFdDirMeansHeld(ownerUid: number, selfUid: number): boolean {
  return ownerUid === selfUid
}

type ProcScan =
  | { readonly kind: "holders"; readonly pids: readonly number[] }
  | { readonly kind: "indeterminate" }
  | { readonly kind: "unavailable" }

interface LockIdentity {
  readonly real: string | undefined
  readonly dev: number
  readonly ino: number
}

function errnoCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined
  const code: unknown = error.code
  return typeof code === "string" ? code : undefined
}

// Each /proc/<pid>/fd entry is a symlink: readlink gives the target's path text, stat through the
// symlink gives the target's (dev, ino). A process holds the lock when the path text equals the
// lock's realpath OR the (dev, ino) pair matches - the text is the fast common case, and the
// inode comparison is the authority for a holder in another mount namespace or behind a bind
// mount, where the same file reads as a different path string.
async function fdTargetsLock(fdPath: string, lock: LockIdentity): Promise<boolean> {
  const target = await readlink(fdPath).catch(() => undefined)
  if (lock.real !== undefined && target === lock.real) return true
  const opened = await stat(fdPath).catch(() => undefined)
  return opened !== undefined && opened.dev === lock.dev && opened.ino === lock.ino
}

async function scanProcFdHolders(lockPath: string, selfUid: number): Promise<ProcScan> {
  const identity = await stat(lockPath).catch(() => undefined)
  // A lock that vanished mid-sweep has no holder; the caller's settle check owns the deletion race.
  if (identity === undefined) return { kind: "holders", pids: [] }
  const lock: LockIdentity = {
    real: await realpath(lockPath).catch(() => undefined),
    dev: identity.dev,
    ino: identity.ino,
  }
  const entries = await readdir("/proc").catch(() => undefined)
  if (entries === undefined) return { kind: "unavailable" }
  let indeterminate = false
  const holders: number[] = []
  await Promise.all(
    entries.map(async (entry) => {
      if (!/^\d+$/.test(entry)) return
      const pid = Number.parseInt(entry, 10)
      const fdDir = join("/proc", entry, "fd")
      let fds: readonly string[]
      try {
        fds = await readdir(fdDir)
      } catch (error) {
        const code = errnoCode(error)
        // ENOENT/ENOTDIR: the process vanished mid-scan, nothing left to classify.
        if (code === "ENOENT" || code === "ENOTDIR") return
        if (code === "EACCES" || code === "EPERM") {
          const owner = await stat(join("/proc", entry)).catch(() => undefined)
          if (owner !== undefined && unreadableFdDirMeansHeld(owner.uid, selfUid)) indeterminate = true
          return
        }
        // An error we cannot classify can never prove "no holder".
        indeterminate = true
        return
      }
      for (const fd of fds) {
        if (await fdTargetsLock(join(fdDir, fd), lock)) {
          holders.push(pid)
          return
        }
      }
    }),
  )
  if (indeterminate) return { kind: "indeterminate" }
  holders.sort((a, b) => a - b)
  return { kind: "holders", pids: holders }
}

// The pre-existing macOS source, semantics unchanged (review LOW 5): exit 1 with empty stdout is
// the ONLY "no holders" answer; a nonzero-abnormal exit, a signal, a timeout, or a spawn error
// (lsof not installed) means the check failed, and failed means indeterminate.
function scanLsofHolders(path: string): Promise<readonly number[] | null> {
  return new Promise((resolveScan) => {
    execFile("lsof", ["-t", "--", path], { windowsHide: true, timeout: 5_000 }, (error, stdout) => {
      const listed = stdout.trim()
      if (listed.length > 0) {
        const pids = listed.split(/\r?\n/).map((line) => Number.parseInt(line, 10))
        resolveScan(pids.every((pid) => Number.isInteger(pid)) ? pids : null)
        return
      }
      if (error === null) {
        resolveScan([])
        return
      }
      const code: unknown = "code" in error ? error.code : undefined
      resolveScan(code === 1 ? [] : null)
    })
  })
}

/** Pids holding `path` open right now, or null when no available source can answer. */
export async function findOpenFileHolderPids(path: string): Promise<readonly number[] | null> {
  if (process.platform === "win32") return null
  // process.geteuid is unix-only; its absence on linux is unexpected, so fail closed (indeterminate).
  const geteuid = process.geteuid
  if (process.platform === "linux" && geteuid !== undefined) {
    const scan = await scanProcFdHolders(path, geteuid.call(process))
    switch (scan.kind) {
      case "holders":
        return scan.pids
      case "indeterminate":
        return null
      case "unavailable":
        break
      default: {
        const exhaustive: never = scan
        throw new GitError(`Unhandled /proc scan outcome: ${JSON.stringify(exhaustive)}`)
      }
    }
  }
  return scanLsofHolders(path)
}

/** Fail closed (review LOW 5): a check that could not answer counts as held, never as clean. */
export async function hasOpenFileHolder(path: string): Promise<boolean> {
  const holders = await findOpenFileHolderPids(path)
  return holders === null || holders.length > 0
}
