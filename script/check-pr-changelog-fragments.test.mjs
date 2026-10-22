import { describe, expect, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// Changelog rule: a PR adds changes/unreleased/<PR number>.md and never edits an Unreleased section.
describe("changelog fragments replace direct Unreleased edits", () => {
  const script = fileURLToPath(new URL("./check-pr-changelog.mjs", import.meta.url))
  const changelog = "## [Unreleased]\n\n## [1.0.0]\nOld note.\n"
  const component = "## Unreleased\n\n## 0.1.0\nOld note.\n"
  // Each case commits one runtime change plus `files` on top of a base, then runs the real CLI.
  const gate = (files, extra = []) => {
    const repo = mkdtempSync(join(tmpdir(), "changelog-fragment-"))
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim()
    const write = (path, text) => {
      mkdirSync(join(repo, path, ".."), { recursive: true })
      writeFileSync(join(repo, path), text)
    }
    try {
      git("init", "-q")
      git("config", "user.name", "YeonGyu-Kim")
      git("config", "user.email", "code.yeon.gyu@gmail.com")
      write("package.json", JSON.stringify({ files: ["runtime.mjs"] }))
      write("runtime.mjs", "export const value = 1\n")
      write("CHANGELOG.md", changelog)
      write("packages/tool/CHANGELOG.md", component)
      write("changes/unreleased/1.md", "### Fixed\n\n- Earlier fix (#1).\n")
      git("add", ".")
      git("commit", "-qm", "base")
      const base = git("rev-parse", "HEAD")
      write("runtime.mjs", "export const value = 2\n")
      for (const [path, text] of Object.entries(files)) write(path, text)
      git("add", ".")
      git("commit", "-qm", "change")
      return spawnSync(process.execPath, [script, "--repo", repo, "--base", base, ...extra], { encoding: "utf8", cwd: repo })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }

  test("passes a PR that only adds a fragment", () => {
    const result = gate({ "changes/unreleased/7.md": "### Fixed\n\n- Runtime value fix (#7).\n" }, ["--pr", "7"])
    expect(result.stdout).toContain("changelog-gate: PASS")
    expect(result.status).toBe(0)
  }, 20_000)
  test.each([
    ["is empty", "changes/unreleased/7.md", "\n"],
    ["holds only headings and comments", "changes/unreleased/7.md", "### Fixed\n<!-- todo -->\n"],
    ["is not named by a number", "changes/unreleased/runtime.md", "- Runtime value fix (#7).\n"],
    ["is not under changes/unreleased", "changes/7.md", "- Runtime value fix (#7).\n"],
  ])("refuses a fragment that %s", (_name, path, text) => {
    expect(gate({ [path]: text }).status).toBe(1)
  }, 20_000)
  test("refuses a fragment named for another PR when the PR number is known", () => {
    const result = gate({ "changes/unreleased/2.md": "### Fixed\n\n- Runtime value fix (#7).\n" }, ["--pr", "7"])
    expect(result.stdout).toContain("changelog-gate: FAIL")
    expect(result.stdout).toContain("changes/unreleased/7.md")
    expect(result.status).toBe(1)
  }, 20_000)
  test("does not count an edit to another PR's existing fragment", () => {
    expect(gate({ "changes/unreleased/1.md": "### Fixed\n\n- Earlier fix, reworded (#1).\n" }).status).toBe(1)
  }, 20_000)
  test.each([
    ["root", "CHANGELOG.md", changelog.replace("## [Unreleased]\n", "## [Unreleased]\n\n**Runtime value fix.** ([#7](https://github.com/code-yeongyu/oh-my-openagent/pull/7))\n")],
    ["component", "packages/tool/CHANGELOG.md", component.replace("## Unreleased\n", "## Unreleased\n\n- Runtime value fix (#7).\n")],
  ])("refuses a PR that edits the %s Unreleased section, even with a fragment or the label", (_name, path, text) => {
    for (const extra of [["--pr", "7"], ["--labels", '["no-changelog"]']]) {
      const result = gate({ [path]: text, "changes/unreleased/7.md": "- Runtime value fix (#7).\n" }, extra)
      expect(result.stdout).toContain("changelog-gate: FAIL")
      expect(result.stdout).toContain(`${path}`)
      expect(result.stdout).toContain("changes/unreleased/")
      expect(result.status).toBe(1)
    }
  }, 20_000)
  test("still allows editing a released section", () => {
    const released = changelog.replace("Old note.", "Old note, corrected.")
    expect(gate({ "CHANGELOG.md": released, "changes/unreleased/7.md": "- Runtime value fix (#7).\n" }).status).toBe(0)
  }, 20_000)
})
