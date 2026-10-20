import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

import { PROVENANCE_FRONTMATTER_KEY, stampReceipt } from "../tools/claim-frontmatter"
import { parseMemoryFile } from "./frontmatter"
import { contentFrontmatterEntries, duplicateFrontmatterKeys } from "./frontmatter-entries"

export type MemoryHookStage = "pre-commit" | "commit-msg"

export interface StagedPath {
  readonly status: string
  readonly path: string
  readonly from?: string
}

const MEMORY_WRITER_TRAILER = /^Omo-Writer: memory-tool$/m
// git quotes a path holding any of these even with core.quotePath=false, and the shell checks read
// git's newline-separated lists; refusing such names keeps every list the shell sees exact.
const GIT_QUOTED_PATH = /["\\\u0000-\u001f\u007f]/

export function parseNameStatusZ(output: string): StagedPath[] {
  const tokens = output.split("\0")
  const paths: StagedPath[] = []
  let index = 0
  while (index < tokens.length) {
    const status = tokens[index++] ?? ""
    if (status === "") break
    const first = tokens[index++] ?? ""
    if (status.startsWith("R") || status.startsWith("C")) {
      paths.push({ status, from: first, path: tokens[index++] ?? "" })
    } else {
      paths.push({ status, path: first })
    }
  }
  return paths
}

export function stagedPaths(cwd: string): StagedPath[] {
  const listed = git(cwd, ["-c", "core.quotePath=false", "diff", "--cached", "-M", "-C", "-z", "--name-status", "--diff-filter=ACMR"])
  if (listed === undefined) throw new Error("memory hook: could not list the staged paths")
  return parseNameStatusZ(listed)
}

// The value the reader would take for the header: the last `provenance` entry of the frontmatter,
// read by the same entry reader parseMemoryFile uses.
export function provenanceOf(content: string | undefined): string | undefined {
  if (content === undefined) return undefined
  return contentFrontmatterEntries(content)?.filter((entry) => entry.key === PROVENANCE_FRONTMATTER_KEY).at(-1)?.value
}

export function preCommitFailures(cwd: string, paths: readonly StagedPath[] = stagedPaths(cwd)): string[] {
  const failures: string[] = []
  for (const { path } of paths) {
    if (GIT_QUOTED_PATH.test(path)) {
      failures.push(`  ${JSON.stringify(path)}: memory file names cannot hold quotes, backslashes or control characters; rename it`)
      continue
    }
    if (!path.endsWith(".md")) continue
    for (const key of duplicateFrontmatterKeys(git(cwd, ["cat-file", "blob", `:${path}`]) ?? "")) {
      failures.push(`  ${path}: duplicate frontmatter key '${key}'; keep one`)
    }
  }
  return failures
}

export function commitMessageFailures(cwd: string, message: string, paths: readonly StagedPath[] = stagedPaths(cwd)): string[] {
  if (MEMORY_WRITER_TRAILER.test(message)) return []
  const bases = ["HEAD", ...mergeHeads(cwd)]
  const failures: string[] = []
  for (const { status, path, from } of paths) {
    if (!path.endsWith(".md")) continue
    const staged = git(cwd, ["cat-file", "blob", `:${path}`])
    const header = provenanceOf(staged)
    if (staged === undefined || header === undefined) continue
    const accepted = bases.some((base, index) => {
      const source = index === 0 && status.startsWith("R") && from !== undefined ? from : path
      return keepsOrLowers(git(cwd, ["cat-file", "blob", `${base}:${source}`]), staged, header)
    })
    if (!accepted) {
      failures.push(`  ${path}: the provenance header is a claim receipt only the memory tool writes; remove that line (or save the note with the memory tool)`)
    }
  }
  return failures
}

// A hand commit may keep a header as it stands on a parent, or lower it exactly the way the memory
// tool lowers it for an unverified edit (a user header becomes "mixed"); it can never raise one.
function keepsOrLowers(base: string | undefined, staged: string, header: string): boolean {
  const prior = provenanceOf(base)
  if (prior === header) return true
  if (base === undefined || prior === undefined) return false
  try {
    return stampReceipt(parseMemoryFile(base).frontmatter, parseMemoryFile(staged).frontmatter, undefined).extra?.[PROVENANCE_FRONTMATTER_KEY] === header
  } catch {
    return false
  }
}

function mergeHeads(cwd: string): string[] {
  const path = git(cwd, ["rev-parse", "--git-path", "MERGE_HEAD"])?.trim()
  if (path === undefined || path === "") return []
  try {
    return readFileSync(path.startsWith("/") || /^[A-Za-z]:/.test(path) ? path : `${cwd}/${path}`, "utf8").split("\n").map((line) => line.trim()).filter(Boolean)
  } catch {
    return []
  }
}

function git(cwd: string, args: readonly string[]): string | undefined {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  return result.status === 0 ? result.stdout : undefined
}

// Entry for the memory hooks: `<runtime> <script> --memory-hook <stage> [message file]`, run by git in
// the repository root. Prints the refusals and returns the exit code.
export function runMemoryHook(args: readonly string[], cwd: string): number {
  const [stage, messageFile] = args
  const failures = stage === "pre-commit"
    ? preCommitFailures(cwd)
    : stage === "commit-msg" && messageFile !== undefined
      ? commitMessageFailures(cwd, readFileSync(messageFile, "utf8"))
      : [`  memory hook: unknown stage ${JSON.stringify(stage)}`]
  if (failures.length === 0) return 0
  process.stdout.write(`${stage === "commit-msg" ? "Claim receipt validation failed:" : "Frontmatter validation failed:"}\n${failures.join("\n")}\n`)
  return 1
}
