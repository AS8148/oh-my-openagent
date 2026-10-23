import { afterEach, describe, expect, it } from "bun:test"
import { realpathSync } from "node:fs"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { removeTree } from "../../../../test-support/remove-tree"
import { GitMemoryRepo } from "../git"
import { parseMemoryFile, renderMemoryFile } from "../memfs/frontmatter"
import { describeFrontmatterViolation, MAX_DESCRIPTION_LENGTH } from "../memfs/frontmatter-validation"
import { installHooks } from "../memfs/hooks"
import { validateCompletion } from "./completion-validation"
import { preflightReflectionDescriptions } from "./description-preflight"
import { createReflectionWorktree, finalizeReflectionWorktree } from "./worktree"

const roots: string[] = []
const path = "reference/note.md"
const body = "\n# Durable note\r\n\r\nBody stays byte-identical.  \r\n"
const oversized = `${"summary ".repeat(139)}ending`
const author = { agentId: "agent-one", authorName: "Reflection Agent", authorEmail: "reflection@omo.local" }

async function fixture(content: string, existing = true) {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "description-preflight-")))
  roots.push(root)
  const parent = new GitMemoryRepo({ dir: join(root, "memory"), agentId: author.agentId })
  await parent.init({
    seedFiles: [
      { relativePath: "reference/base.md", content: renderMemoryFile({ description: "Base" }, "base\n") },
      ...(existing ? [{ relativePath: path, content: renderMemoryFile({ description: "a".repeat(937) }, body) }] : []),
    ],
  })
  const worktree = await createReflectionWorktree(parent, "description", join(root, "worktrees"))
  const child = new GitMemoryRepo({ dir: worktree.dir, agentId: author.agentId })
  await writeFile(join(worktree.dir, path), content)
  await child.commitWrite([path], "reflection expanded summary", author)
  const tip = await child.head()
  if (tip === null) throw new Error("fixture has no reflection tip")
  return { parent, worktree, child, tip }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTree(root, { maxRetries: 10, retryDelay: 200 })))
})

describe("reflection description preflight", () => {
  for (const existing of [true, false]) {
    it(`#given an ${existing ? "existing" : "added"} note with an oversized summary #when preflight runs #then one hooked commit preserves its body and validates`, async () => {
      const { parent, worktree, child, tip } = await fixture(renderMemoryFile({ description: oversized }, body), existing)
      expect(oversized.length).toBe(1118)
      expect(await validateCompletion(worktree, worktree.baseSha)).toMatchObject({
        status: "failed",
        detail: `Reflection commit contains invalid frontmatter in ${path}: 'description' exceeds 1024 characters (1118)`,
      })
      installHooks(worktree.dir, {
        checker: { execPath: process.execPath, script: join(import.meta.dir, "../memfs/memory-hook-cli.ts") },
      })

      const trimmed = await preflightReflectionDescriptions(worktree, worktree.baseSha)

      const content = await readFile(join(worktree.dir, path), "utf8")
      const parsed = parseMemoryFile(content)
      expect(parsed.frontmatter.description).toBe(`${"summary ".repeat(127)}summary…`)
      expect(parsed.frontmatter.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH)
      expect(parsed.body).toBe(body)
      expect(describeFrontmatterViolation(content)).toBeNull()
      expect(trimmed).toEqual([{ path, originalLength: 1118, newLength: 1024 }])
      const commits = await child.log({ limit: 2 })
      expect(commits[0]).toMatchObject({
        authorName: author.authorName,
        authorEmail: author.authorEmail,
      })
      expect(commits[0]?.body).toContain(`Omo-Description-Trimmed: ${path} (1118 -> 1024)`)
      expect(commits[1]?.sha).toBe(tip)
      expect(await parent.head()).toBe(worktree.baseSha)
      expect(await validateCompletion(worktree, worktree.baseSha)).toMatchObject({ status: "valid" })
      expect(await preflightReflectionDescriptions(worktree, worktree.baseSha)).toEqual([])
      expect(await child.head()).toBe(commits[0]?.sha)
    })
  }

  it("#given an oversized summary and duplicate key #when preflight runs #then the invalid note and tip remain untouched", async () => {
    const content = `---\ndescription: ${oversized}\nkind: note\nkind: duplicate\n---\n${body}`
    const { worktree, child, tip } = await fixture(content)

    expect(await preflightReflectionDescriptions(worktree, worktree.baseSha)).toEqual([])

    expect(await child.head()).toBe(tip)
    expect(await readFile(join(worktree.dir, path), "utf8")).toBe(content)
    expect(await validateCompletion(worktree, worktree.baseSha)).toMatchObject({
      status: "failed",
      detail: `Reflection commit contains invalid frontmatter in ${path}: duplicate frontmatter key 'kind'`,
    })
  })

  it("#given no oversized summary #when preflight runs #then it makes no commit", async () => {
    const content = renderMemoryFile({ description: "Short summary" }, body)
    const { worktree, child, tip } = await fixture(content)

    expect(await preflightReflectionDescriptions(worktree, worktree.baseSha)).toEqual([])

    expect(await child.head()).toBe(tip)
    expect(await readFile(join(worktree.dir, path), "utf8")).toBe(content)
  })

  it("#given an oversized word with no spaces #when preflight runs #then it hard-cuts within the limit", async () => {
    const { worktree } = await fixture(renderMemoryFile({ description: "x".repeat(1118) }, body))

    await preflightReflectionDescriptions(worktree, worktree.baseSha)

    expect(parseMemoryFile(await readFile(join(worktree.dir, path), "utf8")).frontmatter.description)
      .toBe(`${"x".repeat(1023)}…`)
  })

  it("#given an existing note expanded to 1118 characters #when finalized #then preflight repairs it before the completion gate", async () => {
    const { parent, worktree } = await fixture(renderMemoryFile({ description: oversized }, body))
    installHooks(worktree.dir)

    const result = await finalizeReflectionWorktree(worktree, {
      mode: "auto",
      summary: "shorten reflection description",
      withWriterLock: async (operation) => operation(),
    })

    expect(result).toMatchObject({ status: "merged", cleanup: { worktreeRemoved: true, branchRemoved: true } })
    const parsed = parseMemoryFile(await readFile(join(parent.dir, path), "utf8"))
    expect(parsed.frontmatter.description).toBe(`${"summary ".repeat(127)}summary…`)
    expect(parsed.body).toBe(body)
  })
})
