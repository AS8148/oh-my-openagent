import { describe, expect, test } from "bun:test"

import { splitItem, type FmEntry } from "../item/frontmatter"
import { mulberry32, pick } from "../item/test-support"
import { planAdoption } from "./adopt"
import { stripT2Blocks } from "./hub-trace"

// 2,000 generated cases are CPU-bound; under host load they exceed bun's 5 s default.
const PROPERTY_TIMEOUT_MS = 60_000
import { t2Block } from "./test-support"

// The oracle never parses a source with the code under test: every source is built from
// facts the test already knows, so a strip bug cannot hide in both sides of the check.

const SIDE = "n.sync-conflict-20261015-mac.md"

function linesOf(text: string): readonly string[] {
  if (text === "") return []
  const lines = text.split("\n")
  if (text.endsWith("\n")) lines.pop()
  return lines
}

function countOf(lines: readonly string[], line: string): number {
  return lines.filter((candidate) => candidate === line).length
}

function representedFacts(text: string): readonly FmEntry[] {
  const parsed = splitItem(text)
  const entries = [...(parsed.fm ?? [])]
  for (const match of parsed.body.matchAll(/^<!-- memory-sync frontmatter conflict: (.+) -->$/gm)) {
    entries.push(...(splitItem(`---\n${match[1]}\n---\n`).fm ?? []))
  }
  return entries
}

function outputOf(plan: ReturnType<typeof planAdoption>, base: string): string {
  return plan.action === "capture" ? plan.workingText : base
}

describe("H1: a mid-body T2 block never glues its neighbours", () => {
  const block = t2Block("2026-10-15", "n.md", '---\nk: "v"\n---\n')

  test("a block right after a text line keeps that line's newline", () => {
    expect(stripT2Blocks(`line1\n${block.slice(1)}line2\n`).body).toBe("line1\nline2\n")
  })

  test("the hub's separated form still strips its blank separator", () => {
    expect(stripT2Blocks(`x\n${block}y\n`).body).toBe("x\ny\n")
    expect(stripT2Blocks(`x\n${block}`).body).toBe("x\n")
  })

  test("a side file with a glued block is adopted with both lines intact", () => {
    const side = `line1\n${block.slice(1)}line2\n`
    const plan = planAdoption([{ path: SIDE, text: side }], { currentText: "base\n", lastMaterialised: null, tombstoned: false })
    const body = linesOf(splitItem(outputOf(plan, "base\n")).body)
    expect(body).toContain("line1")
    expect(body).toContain("line2")
    expect(body.some((line) => line.includes("line1line2"))).toBe(false)
  })

  test("a main file with a glued block keeps both lines", () => {
    const main = `line1\n${block.slice(1)}line2\n`
    const plan = planAdoption([{ path: "n.md", text: main }], { currentText: null, lastMaterialised: null, tombstoned: false })
    expect(linesOf(splitItem(outputOf(plan, "")).body)).toEqual(["line1", "line2"])
  })
})

describe("M1: the read-back counts lines", () => {
  test("a merge that collapses a duplicated line keeps the source", () => {
    const dedupe = (base: string, incoming: string): string => [...new Set(linesOf(base + incoming))].map((l) => `${l}\n`).join("")
    const plan = planAdoption([{ path: SIDE, text: "x\nd\nd\n" }], { currentText: "x\n", lastMaterialised: null, tombstoned: false }, dedupe)
    expect(plan.removeAfterCommit).toEqual([])
    expect(plan.retainedSources.map((entry) => entry.path)).toEqual([SIDE])
  })
})

describe("L1: CRLF sources", () => {
  test("an LF main and a CRLF side do not duplicate shared lines", () => {
    const plan = planAdoption(
      [{ path: "n.md", text: "x\ny\n" }, { path: SIDE, text: "x\r\ny\r\nz\r\n" }],
      { currentText: "x\ny\n", lastMaterialised: null, tombstoned: false },
    )
    const out = outputOf(plan, "x\ny\n")
    expect(out.includes("\r")).toBe(false)
    expect(linesOf(splitItem(out).body)).toEqual(["x", "y", "z"])
    expect(plan.removeAfterCommit).toEqual([SIDE])
  })

  test("a CRLF T2 block is folded into the frontmatter", () => {
    const block = t2Block("2026-10-15", "n.md", '---\nk: "v"\n---\n').replace(/\n/g, "\r\n")
    const plan = planAdoption([{ path: SIDE, text: `x\r\n${block}` }], { currentText: "x\n", lastMaterialised: null, tombstoned: false })
    const out = outputOf(plan, "x\n")
    expect(out.includes("kept here so no fact is lost")).toBe(false)
    expect(representedFacts(out).some((entry) => entry.key === "k")).toBe(true)
  })
})

describe("L2: the local-deletion shortcut", () => {
  test("a CRLF main whose text was deleted locally is still a local deletion", () => {
    const plan = planAdoption(
      [{ path: "n.md", text: "a\r\nc\r\n" }],
      { currentText: "a\nb\nc\n", lastMaterialised: "a\nb\nc\n", tombstoned: false },
    )
    expect(plan.action).toBe("none")
  })

  test("a main that deleted whole lines is still a local deletion", () => {
    const plan = planAdoption(
      [{ path: "n.md", text: "a\nc\n" }],
      { currentText: "a\nb\nc\n", lastMaterialised: "a\nb\nc\n", tombstoned: false },
    )
    expect(plan.action).toBe("none")
  })
})

const POOL = ["- likes tea", "- likes coffee", "abc", "ax", "note: alpha", "prefers 한글", "emoji 🙂", "-->", "--- not fm"] as const

type Built = { readonly text: string; readonly lines: readonly string[]; readonly keys: ReadonlyMap<string, string> }

function build(rand: () => number, tag: string): Built {
  const lines: string[] = []
  const keys = new Map<string, string>()
  let text = ""
  const count = 1 + Math.floor(rand() * 5)
  for (let i = 0; i < count; i++) {
    const line = pick(rand, POOL)
    lines.push(line)
    text += `${line}\n`
    if (rand() < 0.35) {
      const key = `k_${tag}_${i}`
      const value = `v ${tag} ${i}`
      keys.set(key, value)
      const block = t2Block("2026-10-15", "n.md", `---\n${key}: "${value}"\n---\n`)
      text += rand() < 0.5 ? block.slice(1) : block
    }
  }
  return { text: rand() < 0.25 ? text.replace(/\n/g, "\r\n") : text, lines, keys }
}

const LOSSY: readonly ((base: string, incoming: string) => string)[] = [
  (base, incoming) => [...new Set(linesOf(base + incoming))].map((line) => `${line}\n`).join(""),
  (base, incoming) => base + linesOf(incoming).slice(1).map((line) => `${line}\n`).join(""),
]

for (const seed of [20261016, 0x5eed4a11]) {
  test(`R1 every known fact of a deleted source survives, glued blocks and lossy merges included; seed=${seed}`, () => {
    const rand = mulberry32(seed)
    for (let iteration = 0; iteration < 1500; iteration++) {
      const base = "base line\n"
      const main = build(rand, `m${iteration}`)
      const side = build(rand, `s${iteration}`)
      const merge = rand() < 0.3 ? pick(rand, LOSSY) : undefined
      const plan = planAdoption(
        [{ path: "n.md", text: main.text }, { path: SIDE, text: side.text }],
        { currentText: base, lastMaterialised: null, tombstoned: false },
        merge,
      )
      const out = outputOf(plan, base)
      const context = `R1 seed=${seed} case=${iteration} side=${JSON.stringify(side.text)} out=${JSON.stringify(out)}`
      const outLines = linesOf(splitItem(out).body)
      const facts = representedFacts(out)
      if (merge === undefined) {
        for (const line of main.lines) expect(outLines.includes(line), `${context} main lost ${line}`).toBe(true)
        for (const line of outLines) expect(line.includes("kept here so no fact is lost"), `${context} block left in body`).toBe(false)
      }
      if (!plan.removeAfterCommit.includes(SIDE)) {
        expect(plan.retainedSources.map((entry) => entry.path), context).toEqual([SIDE])
        continue
      }
      for (const line of new Set(side.lines)) {
        expect(countOf(outLines, line) >= countOf(side.lines, line), `${context} deleted source lost ${line}`).toBe(true)
      }
      for (const [key, value] of side.keys) {
        const kept = facts.some((entry) => entry.key === key && entry.value.kind === "text" && entry.value.text === value)
        expect(kept, `${context} deleted source lost key ${key}`).toBe(true)
      }
    }
  }, PROPERTY_TIMEOUT_MS)
}
