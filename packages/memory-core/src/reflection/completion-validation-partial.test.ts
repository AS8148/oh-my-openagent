import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test"
import { realpathSync } from "node:fs"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { GitMemoryRepo, createNodeGitExec } from "../git"
import { validateCompletion } from "./completion-validation"
import { createReflectionWorktree } from "./worktree"
import { removeTree } from "../../../../test-support/remove-tree"

const roots: string[] = []
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSk\n-----END RSA PRIVATE KEY-----\n"
const GOOD = "---\ndescription: A good note\n---\n\nbody\n"
const exec = createNodeGitExec()

setDefaultTimeout(process.platform === "win32" ? 30_000 : 20_000)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTree(root, { maxRetries: 10, retryDelay: 200 })))
})

async function fixture(seedFiles: Record<string, string> = {}) {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "reflection-partial-")))
  roots.push(root)
  const repo = new GitMemoryRepo({ dir: join(root, "memory"), agentId: "agent-one" })
  await repo.init({ seedFiles: Object.entries(seedFiles).map(([relativePath, content]) => ({ relativePath, content })) })
  const worktree = await createReflectionWorktree(repo, "run-1", join(root, "worktrees"))
  return { worktree }
}

async function git(dir: string, ...argv: string[]): Promise<string> {
  const result = await exec.run(argv, { cwd: dir, timeoutMs: 30_000 })
  if (result.code !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

async function commit(dir: string, files: Record<string, string>, message: string): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  await git(dir, "add", "-A")
  await git(dir, "-c", "user.email=fixture@example.com", "-c", "user.name=fixture", "commit", "-qm", message)
}

const treePaths = async (dir: string): Promise<string[]> =>
  (await git(dir, "ls-tree", "-r", "--name-only", "HEAD")).split("\n").filter(Boolean)

describe("reflection completion keeps valid notes when one entry fails validation", () => {
  it("#given a good note and a note with a PEM block #when validated #then the good note is kept and the secret file dropped", async () => {
    const { worktree } = await fixture()
    await commit(worktree.dir, { "reference/good.md": GOOD, "reference/leak.md": `---\ndescription: Leak\n---\n\n${PEM}` }, "two notes")

    const result = await validateCompletion(worktree, worktree.baseSha, worktree.exec)

    expect(result.status).toBe("valid")
    if (result.status !== "valid") return
    expect(result.changedPaths).toEqual(["reference/good.md"])
    expect(result.dropped?.map((entry) => entry.path)).toEqual(["reference/leak.md"])
    expect(JSON.stringify(result.dropped)).not.toContain("MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSk")
    expect(await treePaths(worktree.dir)).not.toContain("reference/leak.md")
    expect(await git(worktree.dir, "status", "--porcelain")).toBe("")
  })

  it("#given a secret only in an earlier commit #when validated #then the branch history carries no secret blob", async () => {
    const { worktree } = await fixture()
    await commit(worktree.dir, { "reference/good.md": GOOD, "reference/tmp.md": `---\ndescription: T\n---\n\n${PEM}` }, "add")
    await git(worktree.dir, "rm", "-q", "reference/tmp.md")
    await git(worktree.dir, "-c", "user.email=fixture@example.com", "-c", "user.name=fixture", "commit", "-qm", "remove")

    const result = await validateCompletion(worktree, worktree.baseSha, worktree.exec)

    expect(result.status).toBe("valid")
    if (result.status !== "valid") return
    expect(result.changedPaths).toEqual(["reference/good.md"])
    expect(await git(worktree.dir, "rev-list", "--count", `${worktree.baseSha}..HEAD`)).toBe("1")
  })

  it("#given a note whose description is over 1024 characters #when validated #then it is dropped and the others are kept", async () => {
    const { worktree } = await fixture()
    await commit(worktree.dir, {
      "reference/good.md": GOOD,
      "reference/long.md": `---\ndescription: ${"x".repeat(1100)}\n---\n\nbody\n`,
    }, "notes")

    const result = await validateCompletion(worktree, worktree.baseSha, worktree.exec)

    expect(result.status).toBe("valid")
    if (result.status !== "valid") return
    expect(result.changedPaths).toEqual(["reference/good.md"])
    expect(result.dropped?.[0]?.path).toBe("reference/long.md")
    expect(result.dropped?.[0]?.reason).toContain("exceeds 1024 characters")
  })

  it("#given a frontmatter-less root file moved into reference/ #when validated #then the move is undone and the other note is kept", async () => {
    const { worktree } = await fixture({ "notes-dump.md": "# Title\n\nno frontmatter\n" })
    await mkdir(join(worktree.dir, "reference"), { recursive: true })
    await git(worktree.dir, "mv", "notes-dump.md", "reference/notes-dump.md")
    await commit(worktree.dir, { "reference/good.md": GOOD }, "move and add")

    const result = await validateCompletion(worktree, worktree.baseSha, worktree.exec)

    expect(result.status).toBe("valid")
    if (result.status !== "valid") return
    expect(result.changedPaths).toEqual(["reference/good.md"])
    const paths = await treePaths(worktree.dir)
    expect(paths).toContain("notes-dump.md")
    expect(paths).not.toContain("reference/notes-dump.md")
  })

  it("#given every changed note is invalid #when validated #then nothing is committed and the run reports no changes", async () => {
    const { worktree } = await fixture()
    await commit(worktree.dir, { "reference/leak.md": `---\ndescription: Leak\n---\n\n${PEM}` }, "leak")

    const result = await validateCompletion(worktree, worktree.baseSha, worktree.exec)

    expect(result.status).toBe("no_changes")
    if (result.status !== "no_changes") return
    expect(result.tipSha).toBe(worktree.baseSha)
    expect(result.dropped?.map((entry) => entry.path)).toEqual(["reference/leak.md"])
  })
})
