import { execFile } from "node:child_process"
import { join } from "node:path"

import { readdir, readlink, realpath, stat } from "../fs/resilient"

import { GitError } from "./errors"
import {
  classifyEntryError,
  errnoCode,
  liveProcView,
  scanEveryProcess,
  type EntryVerdict,
  type ProcScan,
  type ProcView,
} from "./proc-view"

export { unreadableFdDirMeansHeld } from "./proc-view"

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

interface LockIdentity {
  readonly real: string | undefined
  readonly dev: number
  readonly ino: number
}

// Each /proc/<pid>/fd entry is a symlink: readlink gives the target's path text, stat through the
// symlink gives the target's (dev, ino). A process holds the lock when the path text equals the
// lock's realpath OR the (dev, ino) pair matches - the text is the fast common case, and the
// inode comparison is the authority for a holder in another mount namespace or behind a bind
// mount, where the same file reads as a different path string. omo #10199 r5 LOW 5: only "the fd
// closed meanwhile" (ENOENT) means "not this lock"; any other per-fd failure is indeterminate.
async function fdVerdict(view: ProcView, pid: number, fdPath: string, lock: LockIdentity): Promise<EntryVerdict> {
  let target: string
  try {
    target = await readlink(fdPath)
  } catch (error) {
    return errnoCode(error) === "ENOENT" ? "no-match" : classifyEntryError(view, pid, error)
  }
  if (lock.real !== undefined && target === lock.real) return "match"
  try {
    const opened = await stat(fdPath)
    return opened.dev === lock.dev && opened.ino === lock.ino ? "match" : "no-match"
  } catch (error) {
    return errnoCode(error) === "ENOENT" ? "no-match" : classifyEntryError(view, pid, error)
  }
}

async function processHoldsLock(view: ProcView, pid: number, lock: LockIdentity): Promise<EntryVerdict> {
  const fdDir = join(view.root, String(pid), "fd")
  let fds: readonly string[]
  try {
    fds = await readdir(fdDir)
  } catch (error) {
    return classifyEntryError(view, pid, error)
  }
  let sawIndeterminate = false
  for (const fd of fds) {
    const verdict = await fdVerdict(view, pid, join(fdDir, fd), lock)
    if (verdict === "match") return "match"
    if (verdict === "indeterminate") sawIndeterminate = true
  }
  return sawIndeterminate ? "indeterminate" : "no-match"
}

export async function scanProcFdHolders(lockPath: string, view: ProcView): Promise<ProcScan> {
  const identity = await stat(lockPath).catch(() => undefined)
  // A lock that vanished mid-sweep has no holder; the caller's settle check owns the deletion race.
  if (identity === undefined) return { kind: "holders", pids: [] }
  const lock: LockIdentity = {
    real: await realpath(lockPath).catch(() => undefined),
    dev: identity.dev,
    ino: identity.ino,
  }
  return scanEveryProcess(view, (pid) => processHoldsLock(view, pid, lock))
}

// The pre-existing macOS source, semantics unchanged (review LOW 5): exit 1 with empty stdout is
// the ONLY "no holders" answer; a nonzero-abnormal exit, a signal, a timeout, or a spawn error
// (lsof not installed) means the check failed, and failed means indeterminate.
function scanLsofHolders(path: string): Promise<readonly number[] | null> {
  return new Promise((resolveScan) => {
    execFile("lsof", ["-t", "--", path], { windowsHide: true, timeout: 5_000 }, (error, stdout) => {
      const listed = stdout.trim()
      if (listed.length > 0) {
        const lines = listed.split(/\r?\n/)
        resolveScan(lines.every((line) => /^\d+$/.test(line)) ? lines.map((line) => Number.parseInt(line, 10)) : null)
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

export async function answerFromProcOrLsof(
  procScan: (view: ProcView) => Promise<ProcScan>,
  lsofScan: () => Promise<readonly number[] | null>,
): Promise<readonly number[] | null> {
  if (process.platform === "win32") return null
  // process.geteuid is unix-only; its absence on linux is unexpected, so fail closed (indeterminate).
  const geteuid = process.geteuid
  if (process.platform === "linux" && geteuid !== undefined) {
    const scan = await procScan(liveProcView(geteuid.call(process)))
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
  return lsofScan()
}

/** Pids holding `path` open right now, or null when no available source can answer. */
export function findOpenFileHolderPids(path: string): Promise<readonly number[] | null> {
  return answerFromProcOrLsof((view) => scanProcFdHolders(path, view), () => scanLsofHolders(path))
}

/** Fail closed (review LOW 5): a check that could not answer counts as held, never as clean. */
export async function hasOpenFileHolder(path: string): Promise<boolean> {
  const holders = await findOpenFileHolderPids(path)
  return holders === null || holders.length > 0
}
