import { describe, expect, test } from "bun:test"

import { itemFrontier, renderForDisk, renderItem } from "./index"
import { captureInto, newDoc } from "./test-support"

// Lead decision r6 (design (b)): the frontmatter is re-emitted from the merged typed model, but a
// file whose typed model is unchanged stays byte-for-byte, whatever its style. Only a real model
// change rewrites it canonically.

const STYLED = "---\n# a comment the model does not keep\nn:   2\ndescription: 'hello there'\ntags: [a, b]\n---\nbody\n"

describe("renderForDisk (lead decision r6)", () => {
  test("a file that differs from the canonical render only in style is returned byte-for-byte", async () => {
    const doc = await newDoc("1")
    captureInto(doc, "", [], STYLED)
    expect(renderItem(doc)).not.toBe(STYLED)
    expect(renderForDisk(doc, STYLED)).toBe(STYLED)
    doc.free()
  })

  test("a model change on a file whose frontmatter does not parse rewrites it canonically", async () => {
    const a = await newDoc("1")
    captureInto(a, "", [], STYLED)
    const b = await newDoc("2")
    b.import(a.export({ mode: "update" }))
    captureInto(b, renderItem(b) ?? "", itemFrontier(b), (renderItem(b) ?? "").replace("n: 2", "n: 3"))
    a.import(b.export({ mode: "update" }))
    const broken = "---\nn: [unclosed\n---\nbody\n"
    expect(renderForDisk(a, broken)).toBe(renderItem(a))
    expect(renderForDisk(a, broken)).toContain("n: 3")
    a.free()
    b.free()
  })

  test("a comment and quoting on an untouched key survive a sync that changes a different key", async () => {
    const a = await newDoc("1")
    captureInto(a, "", [], STYLED)
    const b = await newDoc("2")
    b.import(a.export({ mode: "update" }))
    captureInto(b, renderItem(b) ?? "", itemFrontier(b), (renderItem(b) ?? "").replace("n: 2", "n: 3"))
    a.import(b.export({ mode: "update" }))
    const written = renderForDisk(a, STYLED) ?? ""
    expect(written).toContain("# a comment the model does not keep")
    expect(written).toContain("description: 'hello there'")
    expect(written).toContain("n: 3")
    expect(written).toMatch(/tags: \[ ?a, b ?\]/)
    a.free()
    b.free()
  })

  test("comments on the changed key are handled deterministically: the line above is kept, the old value's inline comment goes", async () => {
    const disk = "---\n# about n\nn: 2 # old value note\nkeep: 'x' # untouched note\n---\nbody\n"
    const a = await newDoc("1")
    captureInto(a, "", [], disk)
    const b = await newDoc("2")
    b.import(a.export({ mode: "update" }))
    captureInto(b, renderItem(b) ?? "", itemFrontier(b), (renderItem(b) ?? "").replace("n: 2", "n: 3"))
    a.import(b.export({ mode: "update" }))
    const written = renderForDisk(a, disk) ?? ""
    expect(written).toBe("---\n# about n\nn: 3\nkeep: 'x' # untouched note\n---\nbody\n")
    expect(renderForDisk(a, disk)).toBe(written)
    a.free()
    b.free()
  })

  test("a body-only difference rewrites only the body and keeps the frontmatter bytes", async () => {
    const doc = await newDoc("1")
    captureInto(doc, "", [], STYLED)
    const stale = STYLED.replace("body\n", "old body\n")
    expect(renderForDisk(doc, stale)).toBe(STYLED)
    doc.free()
  })
})
