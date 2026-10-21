import { afterEach, describe, expect, it } from "bun:test"
import { realpathSync } from "node:fs"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { GitMemoryRepo, type GitCommitAuthor } from "../git"
import { parseMemoryFile } from "../memfs/frontmatter"
import { PROVENANCE_STRIPPED_TRAILER, readHeader } from "./claim-frontmatter"
import { runMemoryTool, type MemoryToolParams } from "./memory"
import { runMemoryApplyPatch } from "./memory-apply-patch"
import { removeTree } from "../../../../test-support/remove-tree"

const AUTHOR: GitCommitAuthor = { agentId: "agent-legacy-test", authorName: "Legacy Test", authorEmail: "legacy@example.com" }
const LEGACY = '"user said \\"yes\\" approving proposal 0123456789abcdef (body sha256:0123456789abcdef)"'
const PROVENANCE = { sessionId: "s", userTurns: 1 } as const
const lock = async <T>(_domain: unknown, operation: () => Promise<T>): Promise<T> => operation()
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTree(root, { maxRetries: 10, retryDelay: 200 })))
})

async function seeded(): Promise<GitMemoryRepo> {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "omo-memory-legacy-")))
  roots.push(root)
  const repo = new GitMemoryRepo({ dir: join(root, "repo"), agentId: AUTHOR.agentId })
  await repo.init({ authorName: AUTHOR.authorName })
  await writeFile(join(repo.dir, "legacy.md"), `---\ndescription: Legacy\nprovenance: ${LEGACY}\n---\n\nTheme: light.\n`)
  await repo.commitWrite(["legacy.md"], "legacy note\n\nOmo-Writer: memory-tool", AUTHOR)
  return repo
}

const run = (repo: GitMemoryRepo, params: Omit<MemoryToolParams, "author" | "reason">) =>
  runMemoryTool({ repo, lock, params: { ...params, reason: `write ${params.command}`, author: AUTHOR, provenance: PROVENANCE } })

async function headerAt(repo: GitMemoryRepo, path: string): Promise<string | undefined> {
  return readHeader(parseMemoryFile(await readFile(join(repo.dir, path), "utf8")).frontmatter)
}

async function lastTrailer(repo: GitMemoryRepo): Promise<string | undefined> {
  return (await repo.log({ limit: 1 }))[0]?.trailers[PROVENANCE_STRIPPED_TRAILER]
}

describe("memory tool: a legacy user header is dropped on edit and the drop is recorded (lead decision C on #10498)", () => {
  it("#given a legacy note #when str_replace edits it #then the header is gone and the commit records the path", async () => {
    const repo = await seeded()
    await run(repo, { command: "str_replace", file_path: "legacy.md", old_string: "light", new_string: "dark" })
    expect(await headerAt(repo, "legacy.md")).toBeUndefined()
    expect(await lastTrailer(repo)).toBe("legacy.md")
  }, 30_000)

  it("#given a legacy note #when update_description rewrites it #then the header is gone and the commit records the path", async () => {
    const repo = await seeded()
    await run(repo, { command: "update_description", file_path: "legacy.md", description: "Theme notes" })
    expect(await headerAt(repo, "legacy.md")).toBeUndefined()
    expect(await lastTrailer(repo)).toBe("legacy.md")
  }, 30_000)

  it("#given a legacy note #when memory_apply_patch updates it #then the header is gone and the commit records the path", async () => {
    const repo = await seeded()
    await runMemoryApplyPatch({ repo, lock, params: { reason: "patch", author: AUTHOR, provenance: PROVENANCE, input: "*** Begin Patch\n*** Update File: legacy.md\n@@\n-Theme: light.\n+Theme: dark.\n*** End Patch" } })
    expect(await headerAt(repo, "legacy.md")).toBeUndefined()
    expect(await lastTrailer(repo)).toBe("legacy.md")
  }, 30_000)

  it("#given a legacy note #when it is renamed #then the new path has no header and the commit records the source path", async () => {
    const repo = await seeded()
    await run(repo, { command: "rename", old_path: "legacy.md", new_path: "moved.md" })
    expect(await headerAt(repo, "moved.md")).toBeUndefined()
    expect(await lastTrailer(repo)).toBe("legacy.md")
  }, 30_000)

  it("#given a legacy note #when it is deleted #then nothing is recorded (a delete is not an edit)", async () => {
    const repo = await seeded()
    await run(repo, { command: "delete", file_path: "legacy.md" })
    expect(await lastTrailer(repo)).toBeUndefined()
  }, 30_000)
})
