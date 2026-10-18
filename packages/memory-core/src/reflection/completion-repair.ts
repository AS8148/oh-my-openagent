import type { GitExec } from "../git"

const GIT_TIMEOUT_MS = 30_000

/** One memory entry the completion gate refused and removed from the run's commit; never carries the matched value. */
export interface DroppedEntry {
  readonly path: string
  readonly reason: string
}

type Run = (argv: readonly string[], env?: Readonly<Record<string, string>>) => Promise<{ code: number; stdout: string; stderr: string }>

function runner(exec: GitExec, dir: string): Run {
  return (argv, env) =>
    exec.run(argv, { cwd: dir, timeoutMs: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env } })
}

async function must(run: Run, argv: readonly string[]): Promise<string> {
  const result = await run(argv)
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${argv.join(" ")} failed`)
  return result.stdout
}

/** destination -> source of every rename in base..tip, so dropping a moved file also undoes the move. */
async function renameSources(run: Run, baseSha: string, tipSha: string): Promise<Map<string, string>> {
  const out = await must(run, ["diff", "--name-status", "-M", "-z", `${baseSha}..${tipSha}`, "--"])
  const parts = out.split("\0")
  const sources = new Map<string, string>()
  for (let index = 0; index < parts.length; ) {
    const status = parts[index] ?? ""
    if (status === "") break
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = parts[index + 1]
      const to = parts[index + 2]
      if (status.startsWith("R") && from !== undefined && to !== undefined) sources.set(to, from)
      index += 3
    } else {
      index += 2
    }
  }
  return sources
}

export async function commitCount(exec: GitExec, dir: string, baseSha: string, tipSha: string): Promise<number> {
  const out = await must(runner(exec, dir), ["rev-list", "--count", `${baseSha}..${tipSha}`])
  return Number.parseInt(out.trim(), 10)
}

/**
 * Rewrite the run's branch as ONE commit on the recorded base that keeps every change except the
 * given paths. Squashing is deliberate: the branch is merged --no-ff with its whole history, so a
 * blob a dropped entry introduced in an earlier commit would otherwise still ride along. A dropped
 * path returns to its base content (or disappears when the base lacked it); when it was the
 * destination of a rename, the rename's source is restored too so no file is lost. Returns the new
 * tip, which is the base itself when nothing is left to keep.
 */
export async function squashWithoutPaths(
  exec: GitExec,
  dir: string,
  baseSha: string,
  tipSha: string,
  dropped: ReadonlySet<string>,
): Promise<string> {
  const run = runner(exec, dir)
  const sources = await renameSources(run, baseSha, tipSha)
  const identity = (await must(run, ["log", "-1", "--format=%an%n%ae%n%s", tipSha])).split("\n")
  const restore = new Set(dropped)
  for (const path of dropped) {
    const source = sources.get(path)
    if (source !== undefined) restore.add(source)
  }
  await must(run, ["reset", "--soft", baseSha])
  for (const path of restore) {
    const inBase = (await run(["cat-file", "-e", `${baseSha}:${path}`])).code === 0
    if (inBase) await must(run, ["checkout", baseSha, "--", path])
    else await must(run, ["rm", "-rf", "-q", "--ignore-unmatch", "--", path])
  }
  if ((await run(["diff", "--cached", "--quiet", baseSha, "--"])).code !== 0) {
    const [name = "reflection", email = "reflection@omo.local", subject = "reflection"] = identity
    await must(run, [
      "-c", `user.name=${name}`, "-c", `user.email=${email}`,
      "commit", "-q", "--no-verify", "-m", `${subject} (kept valid entries)`,
    ])
  }
  return (await must(run, ["rev-parse", "--verify", "HEAD"])).trim()
}
