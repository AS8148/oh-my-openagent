import { afterEach, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { removeTree } from "../../../../test-support/remove-tree"
import { createNodeGitExec } from "./exec"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTree(root)))
})

// A git command that exits before it reads its stdin closes the pipe under a pending write. The write
// then fails with EPIPE on the stdin stream; it must not escape as an uncaught 'error' event (#11129).
test("#given a git command that exits before reading a large stdin #when it runs #then it resolves with git's exit code", async () => {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "git-stdin-epipe-")))
  roots.push(root)
  const exec = createNodeGitExec()
  const git = (argv: readonly string[], stdin?: string) => exec.run(argv, { cwd: root, timeoutMs: 30_000, ...(stdin === undefined ? {} : { stdin }) })
  expect((await git(["init", "-q"])).code).toBe(0)
  // update-index exits at the first path that does not exist, long before it has read 8 MiB of stdin.
  const paths = "note-with-a-long-enough-name.md\0".repeat(256 * 1024)

  const result = await git(["update-index", "-q", "-z", "--stdin"], paths)

  expect(result.code).not.toBe(0)
})
