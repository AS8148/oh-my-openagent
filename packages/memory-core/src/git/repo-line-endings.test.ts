import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { removeTree } from "../../../../test-support/remove-tree"
import { createNodeGitExec } from "./exec"
import { GitMemoryRepo } from "./repo"

const AUTHOR = { agentId: "agent", authorName: "Agent" }
const MIXED = "---\ndescription: mixed endings\n---\n# Note\r\n\r\nBody line.  \r\nlast\n"
const roots: string[] = []
const exec = createNodeGitExec()

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTree(root)))
})

async function tempRoot(): Promise<string> {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "memory-line-endings-")))
  roots.push(root)
  return root
}

async function git(cwd: string, argv: readonly string[]): Promise<string> {
  const result = await exec.run(argv, { cwd, timeoutMs: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
  if (result.code !== 0) throw new Error(`git ${argv.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

// Git for Windows ships core.autocrlf=true in its system/global config. GIT_CONFIG_GLOBAL puts the
// same setting at the global layer on any OS, below the repository's own local config.
async function withWindowsDefaultAutocrlf<T>(root: string, task: () => Promise<T>): Promise<T> {
  const globalConfig = join(root, "global.gitconfig")
  await writeFile(globalConfig, "[core]\n\tautocrlf = true\n")
  const previous = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM }
  process.env.GIT_CONFIG_GLOBAL = globalConfig
  process.env.GIT_CONFIG_NOSYSTEM = "1"
  try {
    return await task()
  } finally {
    if (previous.global === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = previous.global
    if (previous.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
    else process.env.GIT_CONFIG_NOSYSTEM = previous.nosystem
  }
}

describe("memory repository line endings (#11109)", () => {
  test("#given a host whose git converts line endings #when a note is committed and checked out in a worktree #then git keeps every byte", async () => {
    const root = await tempRoot()
    await withWindowsDefaultAutocrlf(root, async () => {
      const repo = new GitMemoryRepo({ dir: join(root, "memory"), agentId: AUTHOR.agentId })
      await repo.init({ installHooks: async () => {} })
      await writeFile(join(repo.dir, "note.md"), MIXED)
      await repo.commitWrite(["note.md"], "add a mixed-ending note", AUTHOR)

      expect(await git(repo.dir, ["cat-file", "blob", "HEAD:note.md"])).toBe(MIXED)
      const checkout = join(root, "checkout")
      await git(repo.dir, ["worktree", "add", "--detach", checkout, "HEAD"])
      expect(await readFile(join(checkout, "note.md"), "utf8")).toBe(MIXED)
    })
  })

  test("#given an existing repository whose checkout gained CRLF copies #when it is opened #then only CRLF-only copies are restored from the index", async () => {
    const root = await tempRoot()
    const repo = new GitMemoryRepo({ dir: join(root, "memory"), agentId: AUTHOR.agentId })
    await repo.init({ installHooks: async () => {} })
    await writeFile(join(repo.dir, "converted.md"), "alpha\nbeta\n")
    await writeFile(join(repo.dir, "edited.md"), "one\ntwo\n")
    await repo.commitWrite(["converted.md", "edited.md"], "seed", AUTHOR)
    // An older build never pinned core.autocrlf, so a Windows checkout wrote CRLF copies.
    await git(repo.dir, ["config", "--local", "--unset-all", "core.autocrlf"]).catch(() => "")
    await writeFile(join(repo.dir, "converted.md"), "alpha\r\nbeta\r\n")
    await writeFile(join(repo.dir, "edited.md"), "one\r\ntwo changed\r\n")

    await new GitMemoryRepo({ dir: repo.dir, agentId: AUTHOR.agentId }).init({ installHooks: async () => {} })

    expect(await readFile(join(repo.dir, "converted.md"), "utf8")).toBe("alpha\nbeta\n")
    expect(await readFile(join(repo.dir, "edited.md"), "utf8")).toBe("one\r\ntwo changed\r\n")
    expect((await git(repo.dir, ["config", "--local", "--get", "core.autocrlf"])).trim()).toBe("false")
  })
})
