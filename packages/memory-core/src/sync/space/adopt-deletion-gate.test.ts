import { expect, test } from "bun:test"

import { splitItem, type FmEntry, type FmValue } from "../item/frontmatter"
import { mulberry32, pick } from "../item/test-support"
import { planAdoption } from "./adopt"
import { stripT2Blocks } from "./hub-trace"

// 2,000 generated cases are CPU-bound; under host load they exceed bun's 5 s default.
const PROPERTY_TIMEOUT_MS = 60_000
import { t2Block } from "./test-support"

// The deletion gate (HIGH-1, structural guarantee): a source file may be queued in
// removeAfterCommit only when a read-back of the merged result proves every one of its
// facts survived — every body line intact, every frontmatter key's value(s) present,
// merged or as a marked conflict. Otherwise the source stays on disk with a reason.

function linesOf(text: string): readonly string[] {
  if (text === "") return []
  const lines = text.split("\n")
  if (text.endsWith("\n")) lines.pop()
  return lines
}

function valuePreserved(wanted: FmValue, actual: FmValue): boolean {
  switch (wanted.kind) {
    case "text":
      return actual.kind === "text" && linesOf(wanted.text).every((line) => linesOf(actual.text).includes(line))
    case "set":
      return actual.kind === "set" && wanted.elements.every((element) => actual.elements.includes(element))
    case "reg":
      return actual.kind === "reg" && actual.value === wanted.value
    case "remove":
      return true // A null is a removal request, not an adopted value.
  }
}

/** All frontmatter entries an output represents: its own keys plus marked conflict payloads. */
function representedFacts(text: string): readonly FmEntry[] {
  const parsed = splitItem(text)
  const entries = [...(parsed.fm ?? [])]
  for (const match of parsed.body.matchAll(/^<!-- memory-sync frontmatter conflict: (.+) -->$/gm)) {
    entries.push(...(splitItem(`---\n${match[1]}\n---\n`).fm ?? []))
  }
  return entries
}

/** The facts a source file carries, exactly the way planAdoption reads them. */
function factsOf(source: string): { readonly bodyLines: readonly string[]; readonly entries: readonly FmEntry[] } {
  const parsed = splitItem(source.replace(/\r\n/g, "\n"))
  const stripped = stripT2Blocks(parsed.body)
  return {
    bodyLines: linesOf(stripped.body),
    entries: [...(parsed.fm ?? []), ...stripped.entries].filter((entry) => entry.value.kind !== "remove"),
  }
}

const LINE_POOL = [
  "- likes tea",
  "- likes coffee",
  "- hates tea",
  "I like tea.",
  "I do not like tea anymore.",
  "ax",
  "abc",
  "xyz",
  "note 3: alpha beta",
  "prefers 한글 메모",
  "emoji line 🙂🚀",
  "",
] as const

function genDoc(rand: () => number, tag: string): string {
  const eol = pick(rand, ["\n", "\n", "\n", "\r\n"])
  const fields: string[] = []
  if (rand() < 0.7) {
    const count = 1 + Math.floor(rand() * 3)
    for (let i = 0; i < count; i++) {
      fields.push(pick(rand, [
        `title: "t-${tag}-${i}"`,
        `tags: [shared, "${tag}-${i}"]`,
        `count: ${Math.floor(rand() * 50)}`,
        `due: 2026-01-0${1 + Math.floor(rand() * 9)}`,
      ]))
    }
  }
  const body = Array.from({ length: Math.floor(rand() * 4) }, () => pick(rand, LINE_POOL))
  const head = fields.length > 0 ? `---${eol}${fields.join(eol)}${eol}---${eol}` : ""
  let text = head + body.join(eol)
  if (text !== "" && rand() < 0.7) text += eol
  return text
}

function genFmOnly(rand: () => number, tag: string): string {
  const text = genDoc(rand, tag)
  const parsed = splitItem(text)
  if (parsed.fm === null || parsed.fm.length === 0) return `---\nnote: "${tag}"\n---\n`
  return `---\n${text.slice(3, text.indexOf("---", 4))}---\n`
}

for (const seed of [20261016, 0xde1e7106]) {
  test(`A3 a deleted source's facts survive intact or it is kept; seed=${seed}, cases=2000`, () => {
    // Given random mains, T2 blocks and side files with overlapping prose and keys.
    const rand = mulberry32(seed)
    for (let iteration = 0; iteration < 2000; iteration++) {
      const space = genDoc(rand, `s${iteration}`)
      let main = genDoc(rand, `m${iteration}`)
      if (rand() < 0.4) main += t2Block("2026-10-15", "n.md", genFmOnly(rand, `t${iteration}`))
      const sides = Array.from({ length: 1 + Math.floor(rand() * 2) }, (_, i) => ({
        path: `n.sync-conflict-20261015-${i === 0 ? "mac" : "mini"}.md`,
        text: genDoc(rand, `x${iteration}-${i}`),
      }))
      const lastMaterialised = rand() < 0.3 ? space : null
      const plan = planAdoption([{ path: "n.md", text: main }, ...sides], {
        currentText: space === "" ? null : space,
        lastMaterialised: lastMaterialised === "" ? null : lastMaterialised,
        tombstoned: false,
      })
      const output = plan.action === "capture" ? plan.workingText : space
      const context = `A3 seed=${seed} case=${iteration}`
      const outFacts = representedFacts(output)
      const outBodyLines = linesOf(splitItem(output).body)
      const retained = new Map((plan.retainedSources ?? []).map((entry) => [entry.path, entry.reason]))
      for (const side of sides) {
        const queued = plan.removeAfterCommit.includes(side.path)
        if (queued) {
          // Then every fact of the deleted source is intact in the output.
          const { bodyLines, entries } = factsOf(side.text)
          for (const line of bodyLines) {
            expect(outBodyLines.includes(line), `${context} deleted ${side.path} lost body line ${JSON.stringify(line)} output=${JSON.stringify(output)}`).toBe(true)
          }
          for (const entry of entries) {
            expect(
              outFacts.some((candidate) => candidate.key === entry.key && valuePreserved(entry.value, candidate.value)),
              `${context} deleted ${side.path} lost ${JSON.stringify(entry)} output=${JSON.stringify(output)}`,
            ).toBe(true)
          }
        } else {
          // Or the source stays on disk and the plan records a structured reason.
          expect(typeof retained.get(side.path), `${context} ${side.path} kept without a reason`).toBe("string")
        }
        expect(queued !== retained.has(side.path), `${context} ${side.path} both queued and retained`).toBe(true)
      }
    }
  }, PROPERTY_TIMEOUT_MS)
}

test("a merge that drops a line keeps the source and records the reason", () => {
  // Given a merge that silently drops the incoming file's lines (forced read-back failure).
  const dropIncoming = (base: string, incoming: string): string => (base === "" ? incoming : base)
  const plan = planAdoption(
    [{ path: "n.sync-conflict-20261015-mac.md", text: "- likes tea\n" }],
    { currentText: "- likes coffee\n", lastMaterialised: null, tombstoned: false },
    dropIncoming,
  )
  // Then the side file is not deleted and the reason names the missing line.
  expect(plan.removeAfterCommit).toEqual([])
  expect(plan.retainedSources ?? []).toEqual([
    { path: "n.sync-conflict-20261015-mac.md", reason: 'missing body line "- likes tea"' },
  ])
})

test("a side file whose facts all survive is queued for deletion", () => {
  const plan = planAdoption(
    [
      { path: "n.md", text: "- likes tea\n- likes coffee\n" },
      { path: "n.sync-conflict-20261015-mac.md", text: "- likes tea\n" },
    ],
    { currentText: "- likes tea\n- likes coffee\n", lastMaterialised: null, tombstoned: false },
  )
  expect(plan.removeAfterCommit).toEqual(["n.sync-conflict-20261015-mac.md"])
  expect(plan.retainedSources ?? []).toEqual([])
})
