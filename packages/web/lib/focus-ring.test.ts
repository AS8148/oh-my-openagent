import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

import { contrastRatio, readRootTokens, resolveColor } from "./design-tokens"

const WEB_ROOT = join(import.meta.dir, "..")
const INKS = ["--ink-0", "--ink-1", "--ink-2", "--ink-3"] as const
const FOCUS_VARIANT = /^(?:group-|peer-)?focus(?:-visible|-within)?(?:\/[\w-]+)?$/
const FOCUS_IN_ARBITRARY_SELECTOR = /:focus(?:-visible|-within)?(?![\w-])/
const OUTLINE_UTILITY = /^-?outline(?:-|$)/

/** Splits `md:[&:focus]:outline-2` into its variants and utility, ignoring `:` inside brackets. */
function splitVariants(token: string): readonly string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < token.length; index++) {
    const char = token[index]
    if (char === "[" || char === "(") depth++
    else if (char === "]" || char === ")") depth--
    else if (char === ":" && depth === 0) {
      parts.push(token.slice(start, index))
      start = index + 1
    }
  }
  parts.push(token.slice(start))
  return parts
}

function isFocusVariant(variant: string): boolean {
  return (
    FOCUS_VARIANT.test(variant) ||
    (variant.includes("[") && FOCUS_IN_ARBITRARY_SELECTOR.test(variant))
  )
}

/** A class token that puts an outline utility behind any focus-state variant, in any position or form. */
function isHandRolledFocusOutline(token: string): boolean {
  const parts = splitVariants(token)
  if (parts.length < 2) return false
  const utility = (parts.at(-1) ?? "").replace(/^!|!$/g, "")
  return OUTLINE_UTILITY.test(utility) && parts.slice(0, -1).some(isFocusVariant)
}

function hasHandRolledFocusOutline(line: string): boolean {
  return line.split(/[\s"'`,{}]+/).some(isHandRolledFocusOutline)
}

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
}

function offendingLines(matches: (line: string) => boolean): readonly string[] {
  return ["app", "components"]
    .flatMap((directory) => sourceFiles(join(WEB_ROOT, directory)))
    .flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          matches(line) ? [`${relative(WEB_ROOT, file)}:${index + 1}`] : [],
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

    expect(offendingLines((line) => indicator.test(line))).toEqual([])
  })

  // Every Tailwind form that puts an outline utility behind a focus-state variant (FIX THE CLASS, #11523).
  test.each([
    ["focus:outline-2"],
    ["focus-visible:outline-2"],
    ["focus-within:outline-2"],
    ["focus:outline"],
    ["focus-visible:outline-none"],
    ["focus-visible:outline-hidden"],
    ["focus:-outline-offset-2"],
    ["focus-visible:outline-offset-2"],
    ["group-focus:outline-2"],
    ["group-focus-visible:outline-2"],
    ["group-focus-within:outline-2"],
    ["peer-focus:outline-2"],
    ["peer-focus-visible:outline-2"],
    ["peer-focus-within:outline-2"],
    ["group-focus/card:outline-2"],
    ["peer-focus-visible/field:outline-2"],
    ["md:focus:outline-2"],
    ["dark:md:focus-visible:outline-none"],
    ["hover:focus-visible:outline-2"],
    ["focus-visible:hover:outline-2"],
    ["group-hover:focus:outline-2"],
    ["[&:focus]:outline-2"],
    ["[&:focus-visible]:outline-ring"],
    ["[&:focus-within]:outline-2"],
    ["[&_a:focus-visible]:outline-2"],
    ["[&:is(:focus)]:outline-2"],
    ["md:[&:focus]:outline-2"],
    ["has-[:focus-visible]:outline-2"],
    ["group-[:focus]:outline-2"],
    ["focus:!outline-2"],
    ["focus:outline-2!"],
    ["focus-visible:outline-[var(--ring)]"],
    ['className="px-2 focus-visible:outline-2"'],
    ['cn("px-2", isOpen && "md:focus:outline")'],
    ["`${base} peer-focus:outline-2`"],
  ])(
    "#given the hand-rolled focus outline %s #when scanned #then the guard catches it",
    (source) => {
      expect(hasHandRolledFocusOutline(source)).toBe(true)
    },
  )

  test.each([
    ["focus-ring"],
    ["focus-ring-inset"],
    ["outline-none"],
    ["md:outline-offset-2"],
    ["hover:outline-2"],
    ["group-hover:outline-2"],
    ["[&:hover]:outline-2"],
    ["focus:bg-ink-3"],
    ["focus-visible:ring-2"],
    ["focus-visible:underline"],
    ["// the focus outline comes from the recipe"],
  ])("#given the non-violation %s #when scanned #then the guard leaves it alone", (source) => {
    expect(hasHandRolledFocusOutline(source)).toBe(false)
  })

  test("#given the components #when scanned #then every focus outline comes from the focus-ring utilities", () => {
    expect(offendingLines(hasHandRolledFocusOutline)).toEqual([])
  })
})
