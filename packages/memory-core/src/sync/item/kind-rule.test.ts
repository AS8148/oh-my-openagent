import { describe, expect, test } from "bun:test"

import { captureItem, itemFrontier, renderItem, splitItem } from "./index"
import { captureInto, newDoc } from "./test-support"

describe("concurrent frontmatter kinds (sync-design §2)", () => {
  test("string vs sequence first writes converge in both delivery orders", async () => {
    const docA = await newDoc("1")
    captureInto(docA, "", [], "---\ntags: alpha\n---\n")
    const docB = await newDoc("2")
    captureInto(docB, "", [], "---\ntags:\n  - x\n  - y\n---\n")

    const updateA = docA.export({ mode: "update" })
    const updateB = docB.export({ mode: "update" })

    const ab = await newDoc("9")
    ab.import(updateA)
    ab.import(updateB)
    const ba = await newDoc("9")
    ba.import(updateB)
    ba.import(updateA)

    const expected = "---\ntags: alpha [x, y]\n---\n"
    expect(renderItem(ab)).toBe(expected)
    expect(renderItem(ba)).toBe(expected)
    ab.free()
    ba.free()
    docA.free()
    docB.free()
  })

  test("the earliest first write fixes the kind: sequence wins when it is earliest", async () => {
    const docA = await newDoc("1")
    captureInto(docA, "", [], "---\ntags:\n  - x\n  - y\n---\n")
    const docB = await newDoc("2")
    captureInto(docB, "", [], "---\ntags: alpha\n---\n")

    const updateA = docA.export({ mode: "update" })
    const updateB = docB.export({ mode: "update" })

    const ab = await newDoc("9")
    ab.import(updateA)
    ab.import(updateB)
    const ba = await newDoc("9")
    ba.import(updateB)
    ba.import(updateA)

    const expected = "---\ntags:\n  - x\n  - alpha\n  - y\n---\n"
    expect(renderItem(ab)).toBe(expected)
    expect(renderItem(ba)).toBe(expected)
    ab.free()
    ba.free()
    docA.free()
    docB.free()
  })

  test("merged renders re-parse and re-capture as zero ops", async () => {
    const docA = await newDoc("1")
    captureInto(docA, "", [], "---\nk: 'a: b'\n---\n")
    const docB = await newDoc("2")
    captureInto(docB, "", [], "---\nk:\n  - z\n---\n")
    const docC = await newDoc("3")
    captureInto(docC, "", [], "---\nflag: true\n---\n")
    const docD = await newDoc("4")
    captureInto(docD, "", [], "---\nflag: 'q: r'\n---\n")

    const orderings = [
      [docA, docB, docC, docD],
      [docD, docC, docB, docA],
    ] as const
    for (const ordering of orderings) {
      const merged = await newDoc("9")
      for (const source of ordering) merged.import(source.export({ mode: "update" }))
      const rendered = renderItem(merged)
      expect(rendered).not.toBeNull()
      const parsed = splitItem(rendered ?? "")
      expect(parsed.fm, `merged render is not valid frontmatter: ${JSON.stringify(rendered)}`).not.toBeNull()
      const again = captureItem(merged, rendered ?? "", itemFrontier(merged), rendered ?? "")
      expect(again, `merged render is not a no-op: ${JSON.stringify(rendered)}`).toBeNull()
      merged.free()
    }
    docA.free()
    docB.free()
    docC.free()
    docD.free()
  })

  test("boolean register vs string first writes converge, losslessly", async () => {
    const docA = await newDoc("1")
    captureInto(docA, "", [], "---\nflag: true\n---\n")
    const docB = await newDoc("2")
    captureInto(docB, "", [], "---\nflag: yes please\n---\n")

    const updateA = docA.export({ mode: "update" })
    const updateB = docB.export({ mode: "update" })

    const ab = await newDoc("9")
    ab.import(updateA)
    ab.import(updateB)
    const ba = await newDoc("9")
    ba.import(updateB)
    ba.import(updateA)

    const expected = "---\nflag: true / yes please\n---\n"
    expect(renderItem(ab)).toBe(expected)
    expect(renderItem(ba)).toBe(expected)
    ab.free()
    ba.free()
    docA.free()
    docB.free()
  })
})
