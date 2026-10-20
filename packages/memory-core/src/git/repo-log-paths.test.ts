import { afterEach, describe, expect, it } from "bun:test"
import { realpathSync } from "node:fs"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createNodeGitExec, GitMemoryRepo, type GitExec } from "./index"
import { removeTree } from "../../../../test-support/remove-tree"

const tempDirs: string[] = []
const git = createNodeGitExec()
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await removeTree(dir, { maxRetries: 20, retryDelay: 250 }).catch(() => undefined)
  }
})

function countingExec(): { readonly exec: GitExec; readonly calls: () => number } {
  let calls = 0
  return {
    exec: {
      run(argv, options) {
        calls += 1
        return git.run(argv, options)
      },
    },
    calls: () => calls,
  }
}

async function run(dir: string, argv: readonly string[]): Promise<string> {
  const result = await git.run(argv, { cwd: dir, timeoutMs: 30_000, env })
  if (result.code !== 0) throw new Error(`git ${argv.join(" ")}: ${result.stderr}`)
  return result.stdout
}

async function commitFiles(dir: string, files: Record<string, string>, message: string): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  await run(dir, ["add", "-A"])
  await run(dir, ["commit", "-q", "-m", message])
}

async function repoWithRootSpacedRenameAndMerge(exec: GitExec): Promise<{ readonly dir: string; readonly repo: GitMemoryRepo }> {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), "memory-log-paths-")))
  tempDirs.push(dir)
  await run(dir, ["init", "-q", "-b", "main"])
  await commitFiles(dir, { "system/persona.md": "p\n" }, "root")
  for (let index = 0; index < 8; index += 1) {
    await commitFiles(dir, { [`reference/note ${index}.md`]: `${index}\n` }, `note ${index}\n\nOmo-Session: s${index % 2}`)
  }
  await run(dir, ["checkout", "-q", "-b", "side"])
  await commitFiles(dir, { "reference/side.md": "side\n", "system/persona.md": "side\n" }, "side edit")
  await run(dir, ["checkout", "-q", "main"])
  await run(dir, ["mv", "reference/note 0.md", "reference/renamed.md"])
  await run(dir, ["commit", "-q", "-m", "rename"])
  await run(dir, ["merge", "-q", "--no-ff", "--no-edit", "side"])
  return { dir, repo: new GitMemoryRepo({ dir, agentId: "agent", exec }) }
}

async function diffTreePaths(dir: string, sha: string): Promise<string[]> {
  return (await run(dir, ["diff-tree", "--no-commit-id", "--name-only", "-z", "-r", sha])).split("\0").filter(Boolean)
}

describe("GitMemoryRepo.log includePaths", () => {
  it("#given a range of many commits #when log reads it with paths #then one git process answers and every commit's paths match diff-tree", async () => {
    // given
    const counting = countingExec()
    const { dir, repo } = await repoWithRootSpacedRenameAndMerge(counting.exec)
    const expected = await Promise.all(
      (await run(dir, ["rev-list", "HEAD"])).trim().split("\n").map(async (sha): Promise<[string, string[]]> => [sha, await diffTreePaths(dir, sha)]),
    )
    const before = counting.calls()

    // when
    const commits = await repo.log({ range: "HEAD", includePaths: true })

    // then
    expect(counting.calls() - before).toBe(1)
    expect(commits.map((commit) => [commit.sha, commit.paths])).toEqual(expected)
    expect(commits.find((commit) => commit.subject === "note 3")?.trailers).toEqual({ "Omo-Session": "s1" })
    expect(commits.find((commit) => commit.subject === "rename")?.paths).toEqual(["reference/note 0.md", "reference/renamed.md"])
  })

  it("#given a pathspec-filtered log #when it reads paths #then each selected commit lists all of its paths like diff-tree", async () => {
    // given
    const { dir, repo } = await repoWithRootSpacedRenameAndMerge(countingExec().exec)

    // when
    const commits = await repo.log({ paths: ["reference/side.md"], includePaths: true })

    // then
    expect(commits.map((commit) => commit.subject)).toEqual(["side edit"])
    expect(commits[0]?.paths).toEqual(await diffTreePaths(dir, commits[0]?.sha ?? ""))
    expect(commits[0]?.paths).toEqual(["reference/side.md", "system/persona.md"])
  })
})
