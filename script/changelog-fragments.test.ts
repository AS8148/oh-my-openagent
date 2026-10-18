import { describe, expect, test } from "bun:test"
import {
  assembleUnreleasedBody,
  fragmentPath,
  FRAGMENT_DIR,
  mergeUnreleased,
  parseFragment,
  readFragments,
  unreleasedBody,
} from "./changelog-fragments"
import { readdirSync, readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))

describe("fragment parsing", () => {
  test.each([
    ["accepts a numeric fragment", "42.md", "**Fixed.** A fix. ([#42](https://github.com/code-yeongyu/oh-my-openagent/pull/42))"],
    ["accepts a fragment with leading zeros in its id", "042.md", "note"],
  ])("%s", (_name, file, content) => {
    expect(parseFragment(file, content)).toEqual({ pr: 42, content })
  })
  test("skips the directory README", () => {
    expect(parseFragment("README.md", "guidance")).toBeNull()
  })
  test.each([
    ["rejects a slug name", "fix-orderBy.md"],
    ["rejects a bare name", "orderBy"],
    ["rejects a non-markdown extension", "42.txt"],
  ])("%s", (_name, file) => {
    expect(() => parseFragment(file, "note")).toThrow(/<pr-number>\.md/)
  })
  test("refuses an empty fragment", () => {
    expect(() => parseFragment("42.md", "  \n")).toThrow(/empty/)
  })
})

describe("fragment directory", () => {
  const dir = (entries: Record<string, string>) => ({
    names: Object.keys(entries),
    read: (name: string) => {
      if (!(name in entries)) throw new Error(`missing fixture file: ${name}`)
      return entries[name]
    },
  })
  test("orders fragments newest PR first", () => {
    const { names, read } = dir({ "9626.md": "a", "10455.md": "b", "10420.md": "c" })
    expect(readFragments(names, read).map((fragment) => fragment.pr)).toEqual([10455, 10420, 9626])
  })
  test("refuses a duplicated PR id", () => {
    const { names, read } = dir({ "42.md": "a", "042.md": "b" })
    expect(() => readFragments(names, read)).toThrow(/duplicate changelog fragment for PR #42/)
  })
  test("refuses a malformed neighbour file", () => {
    const { names, read } = dir({ "42.md": "a", "notes.txt": "b" })
    expect(() => readFragments(names, read)).toThrow(/<pr-number>\.md/)
  })
})

describe("assembly", () => {
  // readFragments orders newest PR first; assembleUnreleasedBody is a pure join over that order.
  const fragments = [
    { pr: 10455, content: "**Newest number.** Entry." },
    { pr: 9626, content: "**Oldest merged.** Entry." },
  ]
  test("joins ordered fragments with one blank line", () => {
    expect(assembleUnreleasedBody(fragments)).toBe("**Newest number.** Entry.\n\n**Oldest merged.** Entry.")
  })
  test("preserves every entry byte-for-byte in a different historical order", () => {
    const assembled = assembleUnreleasedBody([
      { pr: 10455, content: "**Second.** Entry." },
      { pr: 9626, content: "**First in history.** Entry." },
    ])
    expect(assembled.split("\n\n")).toEqual(["**Second.** Entry.", "**First in history.** Entry."])
  })
})

describe("Unreleased section merge", () => {
  const changelog = `# Changelog\n\nIntro.\n\n## [Unreleased]\n\nHand note.\n\n## [1.0.0] - 2026-10-16\n\nOld.\n`
  test("replaces the body and leaves the rest untouched", () => {
    expect(mergeUnreleased(changelog, "**New.** Entry.")).toBe(
      `# Changelog\n\nIntro.\n\n## [Unreleased]\n\n**New.** Entry.\n\n## [1.0.0] - 2026-10-16\n\nOld.\n`,
    )
  })
  test("an empty body reopens the empty shape the release stamp produces", () => {
    expect(mergeUnreleased(changelog, "")).toBe(`# Changelog\n\nIntro.\n\n## [Unreleased]\n\n## [1.0.0] - 2026-10-16\n\nOld.\n`)
  })
  test("refuses a changelog without the Unreleased heading", () => {
    expect(() => mergeUnreleased("# Changelog\n", "body")).toThrow(/## \[Unreleased\]/)
  })
  test("unreleasedBody reads back the merged body", () => {
    expect(unreleasedBody(mergeUnreleased(changelog, "**New.** Entry."))).toBe("**New.** Entry.")
  })
})

describe("migrated repository fragments", () => {
  // The migration moved every ## [Unreleased] paragraph into exactly one fragment named by the PR
  // it links. The contract guards the release assembly input: one paragraph per fragment, own link,
  // deterministic order — the released section is built from these files.
  const dir = join(root, FRAGMENT_DIR)
  const names = readdirSync(dir).filter((name) => name.endsWith(".md"))
  const fragments = readFragments(names, (name) => readFileSync(join(dir, name), "utf8"))
  const link = (pr: number) => new RegExp(`/pull/${pr}\\)`)

  test("every fragment links its own PR", () => {
    expect(fragments.length).toBeGreaterThan(0)
    for (const fragment of fragments) {
      expect(link(fragment.pr).test(fragment.content)).toBe(true)
    }
  })
  test("assembly yields one entry per fragment, newest PR first", () => {
    const assembled = assembleUnreleasedBody(fragments)
    expect(assembled.split("\n\n")).toHaveLength(fragments.length)
    const order = fragments.map((fragment) => fragment.pr)
    expect([...order].sort((left, right) => right - left)).toEqual(order)
  })
  test("the working tree keeps Unreleased assembled only at release time", () => {
    expect(unreleasedBody(readFileSync(join(root, "CHANGELOG.md"), "utf8"))).toBe("")
  })
  test("migration: assembled entries are byte-identical to the pre-migration Unreleased section", () => {
    const base = execFileSync("git", ["-C", root, "show", "ea18975e67:CHANGELOG.md"], { encoding: "utf8" })
    const start = base.indexOf("## [Unreleased]")
    const next = base.indexOf("\n## [", start + 10)
    const paragraphs = base.slice(start + "## [Unreleased]".length, next).trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).sort()
    expect(assembleUnreleasedBody(fragments).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).sort()).toEqual(paragraphs)
  })
  test("fragmentPath names the gate-checked file", () => {
    expect(fragmentPath(42)).toBe(`${FRAGMENT_DIR}/42.md`)
  })
})
