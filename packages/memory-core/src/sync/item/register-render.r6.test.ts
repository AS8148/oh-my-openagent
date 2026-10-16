import { describe, expect, test } from "bun:test"
import { parse as parseYaml } from "yaml"

import { itemFrontier, renderItem, splitItem } from "./index"
import { captureCurrent, captureInto, newDoc } from "./test-support"

// Spec #454 (lead decisions for r6): a register with several values renders as ONE
// double-quoted YAML string whose components are each value's canonical source, deduplicated,
// sorted by UTF-8 bytes, joined with " / "; a single value renders its canonical source
// verbatim. YAML aliases and merge keys resolve before a value is classified; a custom tag makes
// the frontmatter invalid, so the whole file stays body.

async function concurrent(seed: string, left: string, right: string): Promise<string> {
  const a = await newDoc("1")
  captureInto(a, "", [], seed)
  const b = await newDoc("2")
  b.import(a.export({ mode: "update" }))
  captureInto(a, seed, itemFrontier(a), left)
  captureInto(b, seed, itemFrontier(b), right)
  a.import(b.export({ mode: "update" }))
  b.import(a.export({ mode: "update" }))
  const rendered = renderItem(a) ?? ""
  expect(renderItem(b)).toBe(rendered)
  expect(captureCurrent(a, rendered), `re-capture is not a no-op: ${JSON.stringify(rendered)}`).toBeNull()
  a.free()
  b.free()
  return rendered
}

describe("register render (spec #454)", () => {
  test("several values render as one double-quoted string of canonical sources", async () => {
    const rendered = await concurrent("---\nn: 1\n---\n", "---\nn: 2\n---\n", "---\nn: 3\n---\n")
    expect(rendered).toBe('---\nn: "2 / 3"\n---\n')
  })

  test("a string and a number with the same text stay two values, sorted by UTF-8 bytes", async () => {
    const rendered = await concurrent("---\nn: 1\n---\n", "---\nn: 3\n---\n", "---\nn: \"3\"\n---\n")
    expect(parseYaml(rendered.slice(4, rendered.indexOf("\n---", 4)))).toEqual({ n: '"3" / 3' })
  })

  test("a single value renders its canonical source verbatim", async () => {
    const doc = await newDoc("1")
    captureInto(doc, "", [], "---\nn: 2\nflag: true\nname: plain words\n---\n")
    expect(renderItem(doc)).toBe("---\nn: 2\nflag: true\nname: plain words\n---\n")
    doc.free()
  })
})

describe("YAML resolution before classification (spec #454)", () => {
  test("an alias and a merge key classify by their resolved values", async () => {
    const doc = await newDoc("1")
    captureInto(doc, "", [], "---\nbase: &b hello\ncopy: *b\ndefaults: &d { x: 1 }\nitem:\n  <<: *d\n  y: 2\n---\n")
    const fields = new Map((splitItem(renderItem(doc) ?? "").fm ?? []).map((e) => [e.key, e.value]))
    expect(fields.get("copy")).toEqual({ kind: "reg", value: "hello" })
    expect(fields.get("item")).toEqual({ kind: "reg", value: "{ x: 1, y: 2 }" })
    doc.free()
  })

  test("a custom tag makes the frontmatter invalid: the whole file stays body, byte-exact", async () => {
    const text = "---\ndescription: d\nkind: !custom thing\n---\nbody\n"
    expect(splitItem(text).fm).toBeNull()
    const doc = await newDoc("1")
    captureInto(doc, "", [], text)
    expect(renderItem(doc)).toBe(text)
    doc.free()
  })
})
