import { describe, expect, test } from "bun:test"

import { CaptureBaselineError, captureItem, itemFrontier, renderItem } from "./index"
import { captureCurrent, captureInto, newDoc } from "./test-support"

describe("captureItem", () => {
  test("creates a new item from an empty baseline", async () => {
    const doc = await newDoc("1")
    const text = "---\ndescription: hello\n---\nbody text\n"
    const update = captureInto(doc, "", [], text)
    expect(update).not.toBeNull()
    expect(renderItem(doc)).toBe(text)
    doc.free()
  })

  test("produces zero ops when the working text equals the baseline", async () => {
    const doc = await newDoc("1")
    const text = "---\ndescription: hello\n---\nbody text\n"
    captureInto(doc, "", [], text)
    expect(captureItem(doc, text, itemFrontier(doc), text)).toBeNull()
    doc.free()
  })

  test("edits the body only", async () => {
    const doc = await newDoc("1")
    const v1 = "---\ndescription: hello\n---\nbody text\n"
    captureInto(doc, "", [], v1)
    const v2 = "---\ndescription: hello\n---\nbody text\nmore\n"
    captureInto(doc, v1, itemFrontier(doc), v2)
    expect(renderItem(doc)).toBe(v2)
    doc.free()
  })

  test("edits a frontmatter string value", async () => {
    const doc = await newDoc("1")
    const v1 = "---\ndescription: hello\n---\nbody\n"
    captureInto(doc, "", [], v1)
    const v2 = "---\ndescription: world\n---\nbody\n"
    captureInto(doc, v1, itemFrontier(doc), v2)
    expect(renderItem(doc)).toBe(v2)
    doc.free()
  })

  test("adds a typed key as a register and renders it verbatim", async () => {
    const doc = await newDoc("1")
    const v1 = "---\ndescription: hello\n---\nbody\n"
    captureInto(doc, "", [], v1)
    const v2 = "---\ndescription: hello\ncount: 2\n---\nbody\n"
    captureInto(doc, v1, itemFrontier(doc), v2)
    expect(renderItem(doc)).toBe(v2)
    doc.free()
  })

  test("adds a list key as a set rendered as a block sequence", async () => {
    const doc = await newDoc("1")
    const v1 = "---\ndescription: hello\n---\nbody\n"
    captureInto(doc, "", [], v1)
    const v2 = "---\ndescription: hello\ntags:\n  - a\n  - b\n---\nbody\n"
    captureInto(doc, v1, itemFrontier(doc), v2)
    expect(renderItem(doc)).toBe(v2)
    doc.free()
  })

  test("removes a frontmatter key", async () => {
    const doc = await newDoc("1")
    const v1 = "---\ndescription: hello\ncount: 2\n---\nbody\n"
    captureInto(doc, "", [], v1)
    const v2 = "---\ndescription: hello\n---\nbody\n"
    captureInto(doc, v1, itemFrontier(doc), v2)
    expect(renderItem(doc)).toBe(v2)
    doc.free()
  })

  test("keeps an invalid-YAML file as the whole body, byte-exact", async () => {
    const doc = await newDoc("1")
    const bad = "---\n: nope: [\n---\nrest\n"
    captureInto(doc, "", [], bad)
    expect(renderItem(doc)).toBe(bad)
    doc.free()
  })

  test("switching a file to invalid YAML moves everything into the body", async () => {
    const doc = await newDoc("1")
    const v1 = "---\ndescription: hello\n---\nbody\n"
    captureInto(doc, "", [], v1)
    const bad = "---\ndescription: [unclosed\n---\nbody\n"
    captureInto(doc, v1, itemFrontier(doc), bad)
    expect(renderItem(doc)).toBe(bad)
    doc.free()
  })

  test("a stale baseline never deletes text it never saw", async () => {
    const docA = await newDoc("1")
    const v1 = "---\ndescription: d\n---\nalpha beta gamma\n"
    captureInto(docA, "", [], v1)
    const f1 = itemFrontier(docA)

    const docB = await newDoc("2")
    docB.import(docA.export({ mode: "update" }))

    const vA = "---\ndescription: d\n---\nalpha FIRST beta gamma\n"
    captureInto(docA, v1, itemFrontier(docA), vA)

    const vB = "---\ndescription: d\n---\nalpha beta gamma LAST\n"
    const updateB = captureItem(docB, v1, f1, vB)
    expect(updateB).not.toBeNull()
    if (updateB !== null) docA.import(updateB)

    expect(renderItem(docA)).toBe("---\ndescription: d\n---\nalpha FIRST beta gamma LAST\n")
    docA.free()
    docB.free()
  })

  test("a stale writer's wholesale delete cannot remove concurrent inserts", async () => {
    const docA = await newDoc("1")
    const v1 = "old body\n"
    captureInto(docA, "", [], v1)
    const f1 = itemFrontier(docA)

    const docB = await newDoc("2")
    docB.import(docA.export({ mode: "update" }))

    captureInto(docA, v1, itemFrontier(docA), "NEW old body\n")

    const updateB = captureItem(docB, v1, f1, "fresh\n")
    expect(updateB).not.toBeNull()
    if (updateB !== null) docA.import(updateB)

    const rendered = renderItem(docA)
    expect(rendered).toContain("NEW")
    expect(rendered).toContain("fresh")
    docA.free()
    docB.free()
  })

  test("throws CaptureBaselineError when baseText disagrees with the fork state", async () => {
    const doc = await newDoc("1")
    captureInto(doc, "", [], "real base\n")
    let caught: unknown
    try {
      captureItem(doc, "wrong base\n", itemFrontier(doc), "anything\n")
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CaptureBaselineError)
    doc.free()
  })

  test("re-typing a key converts into its fixed first-write kind", async () => {
    const doc = await newDoc("1")
    const v1 = "---\nkey: hello\n---\n"
    captureInto(doc, "", [], v1)
    const v2 = "---\nkey: 7\n---\n"
    captureInto(doc, v1, itemFrontier(doc), v2)
    expect(renderItem(doc)).toBe("---\nkey: \"7\"\n---\n")
    expect(captureCurrent(doc, renderItem(doc) ?? "")).toBeNull()
    const v3 = "---\nkey: 8\n---\n"
    captureInto(doc, "---\nkey: \"7\"\n---\n", itemFrontier(doc), v3)
    expect(renderItem(doc)).toBe("---\nkey: \"8\"\n---\n")
    doc.free()
  })
})
