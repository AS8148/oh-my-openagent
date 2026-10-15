import { describe, expect, test } from "bun:test"

import { renderItem } from "./index"
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
