import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

import { contrastRatio, readRootTokens, resolveColor } from "./design-tokens"

const WEB_ROOT = join(import.meta.dir, "..")
const INKS = ["--ink-0", "--ink-1", "--ink-2", "--ink-3"] as const
const HAND_ROLLED_FOCUS_OUTLINE =
  /(?:^|[\s"'`:])(?:focus|focus-visible|focus-within|\[&:focus(?:-visible|-within)?\]):-?outline-/

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
}

function offendingLines(pattern: RegExp): readonly string[] {
  return ["app", "components"]
    .flatMap((directory) => sourceFiles(join(WEB_ROOT, directory)))
    .flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          pattern.test(line) ? [`${relative(WEB_ROOT, file)}:${index + 1}`] : [],
        ),
    )
}

describe("focus ring token", () => {
  test.each(INKS)(
    "#given the --ring token #when drawn on %s #then it meets the 3:1 non-text contrast of WCAG 1.4.11",
    (ink) => {
      const tokens = readRootTokens()

      const ratio = contrastRatio(resolveColor(tokens, "--ring"), resolveColor(tokens, ink))

      expect(ratio).toBeGreaterThanOrEqual(3)
    },
  )
})

describe("focus ring recipe, the DESIGN.md §8 one-recipe architecture contract", () => {
  test("#given the components #when scanned #then no focus or selection indicator is drawn in --accent-32", () => {
    const indicator =
      /(?:focus(?:-visible|-within)?|data-\[active=true\]):[^\s"'`]*accent-32|outline-accent-32|outline-\[var\(--accent-32\)\]/

    expect(offendingLines(indicator)).toEqual([])
  })

  test.each([
    "focus-visible:outline-2",
    "focus:outline-accent",
    "focus-within:-outline-offset-2",
    "[&:focus-visible]:outline-2",
    "[&:focus]:outline-ring",
  ])(
    "#given the hand-rolled focus outline %s #when matched #then the guard catches it",
    (className) => {
      expect(HAND_ROLLED_FOCUS_OUTLINE.test(className)).toBe(true)
    },
  )

  test("#given the components #when scanned #then every focus outline comes from the focus-ring utilities", () => {
    expect(offendingLines(HAND_ROLLED_FOCUS_OUTLINE)).toEqual([])
  })
})
