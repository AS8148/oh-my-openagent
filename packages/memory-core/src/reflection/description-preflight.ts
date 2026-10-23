import { join } from "node:path"
import { lstat, readFile, writeFile } from "../fs/resilient"
import { GitMemoryRepo, type GitExec } from "../git"
import { parseMemoryFile, renderMemoryFile } from "../memfs/frontmatter"
import { describeFrontmatterViolation, MAX_DESCRIPTION_LENGTH } from "../memfs/frontmatter-validation"
import { isMemoryContentPath } from "../memfs/paths"
import { listReflectionChangedPaths } from "./completion-validation"
import type { ReflectionWorktree } from "./worktree"

export interface TrimmedDescription {
  readonly path: string
  readonly originalLength: number
  readonly newLength: number
}

/** Repair only length violations in a clean, finished reflection branch, before its pure gate runs. */
export async function preflightReflectionDescriptions(
  worktree: ReflectionWorktree,
  recordedBase: string,
  exec: GitExec = worktree.exec,
): Promise<readonly TrimmedDescription[]> {
  // Leave dirty or tampered runs to the gate; never commit their unrelated changes.
  if (await readFile(worktree.gitFilePath, "utf8") !== worktree.gitFileSnapshot) return []
  const config = await readFile(worktree.commonConfigPath, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  })
  if (config !== worktree.commonConfigSnapshot) return []
  const git = async (argv: readonly string[]) => {
    const result = await exec.run(argv, {
      cwd: worktree.dir,
      timeoutMs: 30_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })
    if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${argv.join(" ")} failed`)
    return result.stdout.trimEnd()
  }
  if ((await git(["status", "--porcelain"])).trim()) return []
  if (await git(["branch", "--show-current"]) !== worktree.branch) return []
  const tipSha = await git(["rev-parse", "--verify", "HEAD"])
  if (tipSha === recordedBase) return []
  const based = await exec.run(["merge-base", "--is-ancestor", recordedBase, tipSha], {
    cwd: worktree.dir,
    timeoutMs: 30_000,
  })
  if (based.code !== 0) return []

  const trimmed: TrimmedDescription[] = []
  for (const path of await listReflectionChangedPaths(exec, worktree.dir, recordedBase, tipSha)) {
    if (!isMemoryContentPath(path)) continue
    const blob = await exec.run(["show", `${tipSha}:${path}`], { cwd: worktree.dir, timeoutMs: 30_000 })
    if (blob.code !== 0) continue // Deleted paths have no description to repair.
    const content = blob.stdout
    const violation = describeFrontmatterViolation(content)
    if (violation === null) continue
    // Grammar is validated before description length, so equality excludes every other violation.
    if (!violation.startsWith(`'description' exceeds ${MAX_DESCRIPTION_LENGTH} characters (`)) continue
    const parsed = parseMemoryFile(content)
    const original = parsed.frontmatter.description
    if (violation !== `'description' exceeds ${MAX_DESCRIPTION_LENGTH} characters (${original.length})`) continue
    const absolute = join(worktree.dir, path)
    if (!(await lstat(absolute)).isFile()) continue
    const prefix = original.slice(0, MAX_DESCRIPTION_LENGTH - 1)
    const boundary = original.lastIndexOf(" ", MAX_DESCRIPTION_LENGTH - 1)
    const description = `${(boundary > 0 ? original.slice(0, boundary) : prefix).trimEnd()}…`
    await writeFile(absolute, renderMemoryFile({ ...parsed.frontmatter, description }, parsed.body), "utf8")
    trimmed.push({ path, originalLength: original.length, newLength: description.length })
  }
  if (trimmed.length === 0) return trimmed

  const [authorName = "", authorEmail = ""] = (await git(["show", "-s", "--format=%an%x00%ae", tipSha])).split("\0")
  const repo = new GitMemoryRepo({ dir: worktree.dir, agentId: worktree.parent.agentId, exec })
  await repo.commitWrite(
    trimmed.map(({ path }) => path),
    [
      "fix(reflection): trim oversized memory descriptions",
      "",
      ...trimmed.map(({ path, originalLength, newLength }) =>
        `Omo-Description-Trimmed: ${path} (${originalLength} -> ${newLength})`),
    ].join("\n"),
    { agentId: worktree.parent.agentId, authorName, authorEmail },
  )
  return trimmed
}
