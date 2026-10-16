import { expect, test } from "bun:test"

import { splitItem, type FmEntry, type FmValue } from "../item/frontmatter"
import { mulberry32, pick } from "../item/test-support"
import { planAdoption } from "./adopt"

// 2,000 generated cases are CPU-bound; under host load they exceed bun's 5 s default.
const PROPERTY_TIMEOUT_MS = 60_000
import { t2Block } from "./test-support"

function preserved(wanted: FmValue, actual: FmValue): boolean {
  switch (wanted.kind) {
    case "text":
      return actual.kind === "text" && wanted.text.split("\n").every((line) => actual.text.split("\n").includes(line))
    case "set":
      return actual.kind === "set" && wanted.elements.every((element) => actual.elements.includes(element))
    case "reg":
      return actual.kind === "reg" && actual.value === wanted.value
    case "remove":
      return true // A null is a removal request, not an adopted value.
  }
}

function represented(text: string): readonly FmEntry[] {
  const parsed = splitItem(text)
  const entries = [...(parsed.fm ?? [])]
  // Conflict payloads are ordinary YAML flow maps, one atomic marked line each.
  for (const match of parsed.body.matchAll(/^<!-- memory-sync frontmatter conflict: (.+) -->$/gm)) {
    entries.push(...(splitItem(`---\n${match[1]}\n---\n`).fm ?? []))
  }
  return entries
}

function assertPreserved(sources: readonly string[], output: string, context: string): void {
  const actual = represented(output)
  for (const source of sources) {
    for (const entry of splitItem(source).fm ?? []) {
      expect(
        actual.some((candidate) => candidate.key === entry.key && preserved(entry.value, candidate.value)),
        `${context} missing ${JSON.stringify(entry)} output=${JSON.stringify(output)}`,
      ).toBe(true)
    }
  }
}

for (const seed of [20261016, 0x5a17c0de]) {
  test(`A1 adoption preserves all source keys and values; seed=${seed}, cases=2000`, () => {
    // Given random overlapping keys, kinds and values in all four real sources,
    // including duplicate keys, non-ASCII, CRLF, unterminated and empty files.
    const rand = mulberry32(seed)
    const make = (source: number, iteration: number) => {
      if (rand() < 0.03) return ""
      const fields: string[] = []
      for (let key = 0; key < 4; key++) {
        if (rand() < 0.2) continue
        const token = `value-${iteration}-${source}-${key}`
        fields.push(pick(rand, [
          `k${key}: "${token}"`,
          `k${key}: [shared, "${token}"]`,
          `k${key}: ${source + iteration * 4}`,
          `k${key}: []`,
          `k${key}: "shared\\n${token} --> end"`,
          `k${key}: "한글-${token} 🙂"`,
          `키${key}: "${token}"`,
        ]))
      }
      if (rand() < 0.06 && fields.length > 0) fields.push(fields[0] ?? "")
      const eol = rand() < 0.2 ? "\r\n" : "\n"
      const header = fields.length ? fields.join(eol) : "empty: shared"
      const closing = rand() < 0.1 ? "---" : `---${eol}`
      return `---${eol}${header}${eol}${closing}`
    }
    for (let iteration = 0; iteration < 2000; iteration++) {
      const sources = Array.from({ length: 4 }, (_, source) => make(source, iteration))
      const [space = "", main = "", t2 = "", side = ""] = sources
      const sidePath = "n.sync-conflict-20261015-device.md"
      // When the plan folds a T2 block and a T1 side file into an existing space.
      const files = [
        { path: "n.md", text: main + t2Block("2026-10-15", "n.md", t2) },
        { path: sidePath, text: side },
      ]
      const plan = planAdoption(files, { currentText: space, lastMaterialised: null, tombstoned: false })
      const output = plan.action === "capture" ? plan.workingText : space
      // Then every value survives, including those whose only source is deleted.
      const context = `A1 seed=${seed} case=${iteration}`
      assertPreserved(sources, output, context)
      if (plan.removeAfterCommit.includes(sidePath)) assertPreserved([side], output, context)
      expect(plan.action, context).not.toBe("remove")
      const repeated = planAdoption(files, { currentText: output, lastMaterialised: null, tombstoned: false })
      expect(repeated.action, `${context} repeated adoption`).toBe("none")
    }
  }, PROPERTY_TIMEOUT_MS)
}

test("existing-key T2 and T1 values survive capture into the real item model", async () => {
  // Given the hub's actual differing-existing-key shape, not an absent-key fixture.
  const { captureInto, newDoc } = await import("../item/test-support")
  const { renderDocContent } = await import("../item/render")
  const main = "---\ntitle: Main\ntags: [a]\nreviewed: true\n---\nmain\n"
  const other = "---\ntitle: Other\ntags: [a, b]\nreviewed: false\n---\n"
  const side = "---\ntitle: Side\ntags: [c]\nreviewed: 3\n---\nside\n"
  const plan = planAdoption([
    { path: "n.md", text: main + t2Block("2026-10-15", "n.md", other) },
    { path: "n.sync-conflict-20261015-device.md", text: side },
  ], { currentText: null, lastMaterialised: null, tombstoned: false })
  expect(plan.action).toBe("capture")
  if (plan.action !== "capture") throw new Error("expected capture")
  const doc = await newDoc("1")
  try {
    // When the plan is committed as real CRDT operations.
    captureInto(doc, "", [], plan.workingText)
    // Then the committed render, not merely the plan, retains all values.
    assertPreserved([main, other, side], renderDocContent(doc), "existing-key capture")
  } finally {
    doc.free()
  }
})
