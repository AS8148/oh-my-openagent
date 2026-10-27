import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

import { contrastRatio, readRootTokens, resolveColor } from "./design-tokens"

const WEB_ROOT = join(import.meta.dir, "..")
const INKS = ["--ink-0", "--ink-1", "--ink-2", "--ink-3"] as const

function componentFiles(): readonly string[] {
  return ["app", "components"].flatMap((directory) =>
    readdirSync(join(WEB_ROOT, directory), { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
      .map((entry) => join(entry.parentPath, entry.name)),
  )
}

function openingTagAround(source: string, index: number): string {
  const start = source.lastIndexOf("<", index)
  const end = source.slice(index).search(/[^=]>/)
  return source.slice(start, end === -1 ? source.length : index + end + 2)
}

describe("receded text role", () => {
  test.each(INKS)(
    "#given --text-lo, the colour receded and dimmed text uses #when drawn on %s #then it meets the 4.5:1 text contrast of WCAG 1.4.3",
    (ink) => {
      const tokens = readRootTokens()

      const ratio = contrastRatio(resolveColor(tokens, "--text-lo"), resolveColor(tokens, ink))

      expect(ratio).toBeGreaterThanOrEqual(4.5)
    },
  )
})

describe("--text-faint, the DESIGN.md \u00a72 decoration-only token contract", () => {
  test("#given the components #when scanned #then every element drawn in text-text-faint is hidden from assistive technology", () => {
    const exposed = componentFiles().flatMap((file) => {
      const source = readFileSync(file, "utf8")
      return [...source.matchAll(/text-text-faint/g)].flatMap((match) =>
        openingTagAround(source, match.index).includes('aria-hidden="true"')
          ? []
          : [`${relative(WEB_ROOT, file)}:${source.slice(0, match.index).split("\n").length}`],
      )
    })

    expect(exposed).toEqual([])
  })
})
