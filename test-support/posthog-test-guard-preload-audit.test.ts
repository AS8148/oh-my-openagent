import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

// Architecture contract (#10394): every Bun test runner config in the repo installs the PostHog test
// guard, either through the shared guard preload or through the root test-setup.ts that installs it.
// A new package that adds its own bunfig [test] section without the guard fails here.
const repoRoot = resolve(import.meta.dir, "..")
const guardPreloads = new Set([join(repoRoot, "test-support/posthog-test-guard.preload.ts"), join(repoRoot, "test-setup.ts")])

function bunfigPaths(): string[] {
  const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*bunfig*.toml"], { cwd: repoRoot, encoding: "utf8" })
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`)
  return listed.stdout.split("\n").filter((path) => path.length > 0)
}

function testPreloads(bunfigPath: string): string[] | undefined {
  const parsed: { test?: { preload?: string | string[] } } = Bun.TOML.parse(readFileSync(join(repoRoot, bunfigPath), "utf8"))
  if (parsed.test === undefined) return undefined
  const preload = parsed.test.preload ?? []
  return (Array.isArray(preload) ? preload : [preload]).map((entry) => resolve(repoRoot, dirname(bunfigPath), entry))
}

describe("PostHog test guard preload audit (#10394)", () => {
  test("#given every bunfig with a [test] section #when its preloads are resolved #then each one installs the PostHog test guard", () => {
    // given
    const configs = bunfigPaths().flatMap((path) => {
      const preloads = testPreloads(path)
      return preloads === undefined ? [] : [{ path, preloads }]
    })

    // when
    const unguarded = configs.filter(({ preloads }) => !preloads.some((preload) => guardPreloads.has(preload))).map(({ path }) => path)

    // then
    expect(configs.map(({ path }) => path)).toEqual(expect.arrayContaining(["bunfig.toml", "packages/omo-senpi/bunfig.toml", "packages/senpi-task/bunfig.toml"]))
    expect(unguarded).toEqual([])
  })
})
