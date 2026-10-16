import { execFile } from "node:child_process"
import { join, resolve, sep } from "node:path"

import { readlink, realpath, stat } from "../fs/resilient"

import { answerFromProcOrLsof } from "./open-file-holders"
import { classifyEntryError, errnoCode, scanEveryProcess, type EntryVerdict, type ProcScan, type ProcView } from "./proc-view"

// omo #10199 r5 HIGH 1: the dead-owner proof covers the process that held the memory-write lock,
// not the git child that created the lock file. A SIGKILLed writer's git keeps running as an
// orphan (in a hook, with index.lock written and its fd CLOSED, so no open-file check sees it).
// Git always works with its cwd at the worktree top (or inside the git dir), and so do its hooks,
// so "some live process other than this one has its cwd inside the repository" is the liveness
// check that covers the orphan, the owner's whole process group, and any other live git writer.
// This process is excluded; its own in-flight git children are not.

type RepoTree = { readonly roots: readonly string[]; readonly dev: number; readonly ino: number }

function inside(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))
}

async function repoTree(dir: string): Promise<RepoTree | null> {
  const identity = await stat(dir).catch(() => undefined)
  if (identity === undefined) return null
  const real = await realpath(dir).catch(() => undefined)
  return { roots: [...new Set([resolve(dir), ...(real === undefined ? [] : [real])])], dev: identity.dev, ino: identity.ino }
}

async function cwdVerdict(view: ProcView, pid: number, tree: RepoTree): Promise<EntryVerdict> {
  if (pid === view.selfPid) return "no-match"
  const cwdLink = join(view.root, String(pid), "cwd")
  let target: string
  try {
    target = await readlink(cwdLink)
  } catch (error) {
    return classifyEntryError(view, pid, error)
  }
  if (inside(target, tree.roots)) return "match"
  // The path text can differ for the same directory (another mount namespace, a bind mount);
  // the repository root itself is where git sits, so its (dev, ino) is the authority there.
  try {
    const cwd = await stat(cwdLink)
    return cwd.dev === tree.dev && cwd.ino === tree.ino ? "match" : "no-match"
  } catch (error) {
    return errnoCode(error) === "ENOENT" ? "no-match" : classifyEntryError(view, pid, error)
  }
}

export async function scanProcCwdUsers(dir: string, view: ProcView): Promise<ProcScan> {
  const tree = await repoTree(dir)
  if (tree === null) return { kind: "indeterminate" }
  return scanEveryProcess(view, (pid) => cwdVerdict(view, pid, tree))
}

// macOS: one lsof listing of every same-user process's cwd (-Fpn: `p<pid>` then `n<path>`). Only a
// clean exit whose listing includes THIS process counts as an answer: anything else (lsof
// missing, a timeout, a signal, a truncated listing) is indeterminate.
function scanLsofCwdUsers(dir: string): Promise<readonly number[] | null> {
  return repoTree(dir).then((tree) => {
    const uid = process.getuid?.()
    if (tree === null || uid === undefined) return null
    return new Promise((resolveScan) => {
      const argv = ["-w", "-a", "-d", "cwd", "-u", String(uid), "-Fpn"]
      execFile("lsof", argv, { windowsHide: true, timeout: 10_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
        if (error !== null) {
          resolveScan(null)
          return
        }
        let pid: number | undefined
        let sawSelf = false
        const users = new Set<number>()
        for (const line of stdout.split("\n")) {
          if (line.startsWith("p")) {
            pid = Number.parseInt(line.slice(1), 10)
            if (pid === process.pid) sawSelf = true
          } else if (line.startsWith("n") && pid !== undefined && pid !== process.pid && inside(line.slice(1), tree.roots)) {
            users.add(pid)
          }
        }
        resolveScan(sawSelf ? [...users].sort((a, b) => a - b) : null)
      })
    })
  })
}

/** Pids other than this process working inside `dir` right now, or null when that cannot be told. */
export function findProcessesWorkingIn(dir: string): Promise<readonly number[] | null> {
  return answerFromProcOrLsof((view) => scanProcCwdUsers(dir, view), () => scanLsofCwdUsers(dir))
}
