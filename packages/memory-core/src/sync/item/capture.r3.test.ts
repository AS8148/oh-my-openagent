import { describe, expect, test } from "bun:test"

import { captureItem, itemFrontier, renderItem } from "./index"
import { captureCurrent, captureInto, newDoc } from "./test-support"

// review r3 (oMo PR #10203): capture must be idempotent. Replaying an identical capture
// (a double-firing watcher, or a crash between importing the update and saving the new
// baseline) must be a no-op, and a user's hand resolution of a register conflict must
// survive the next capture and the next sync on every device.

describe("review r3: idempotent capture", () => {
  test("a double-fired body capture applies the edit exactly once", async () => {
    const doc = await newDoc("1")
    captureInto(doc, "", [], "hello\n")
    const f1 = itemFrontier(doc)
    const first = captureItem(doc, "hello\n", f1, "hello A\n")
    if (first !== null) doc.import(first)
    const replay = captureItem(doc, "hello\n", f1, "hello A\n")
    if (replay !== null) doc.import(replay)
    expect(renderItem(doc)).toBe("hello A\n")
    doc.free()
  })

  test("a crash replay (update imported, baseline never saved) is a no-op", async () => {
    const doc = await newDoc("1")
    captureInto(doc, "", [], "line1\n")
    const f1 = itemFrontier(doc)
    const update = captureItem(doc, "line1\n", f1, "line1\nline2\n")
    if (update !== null) doc.import(update)
    // Crash window: the engine restarts holding the OLD baseline and re-fires the watcher.
    const replay = captureItem(doc, "line1\n", f1, "line1\nline2\n")
    expect(replay).toBeNull()
    expect(renderItem(doc)).toBe("line1\nline2\n")
    doc.free()
  })

  test("a double-fired frontmatter text capture does not duplicate the value", async () => {
    const doc = await newDoc("1")
    const v1 = "---\ndescription: hi\n---\n"
    captureInto(doc, "", [], v1)
    const f1 = itemFrontier(doc)
    const v2 = "---\ndescription: hi there\n---\n"
    const first = captureItem(doc, v1, f1, v2)
    if (first !== null) doc.import(first)
    const replay = captureItem(doc, v1, f1, v2)
    if (replay !== null) doc.import(replay)
    expect(renderItem(doc)).toBe(v2)
    doc.free()
  })

  test("a hand-resolved register conflict survives the next capture and sync on both devices", async () => {
    const docA = await newDoc("1")
    const docB = await newDoc("2")
    captureInto(docA, "", [], "---\nn: 2\n---\n")
    captureInto(docB, "", [], "---\nn: 3\n---\n")
    docA.import(docB.export({ mode: "update" }))
    docB.import(docA.export({ mode: "update" }))
    const conflicted = renderItem(docA) ?? ""
    expect(renderItem(docB) ?? "").toBe(conflicted)
    expect(conflicted).toContain("2 / 3")

    // The user resolves the conflict by hand on device A.
    const resolved = "---\nn: 2\n---\n"
    const resolution = captureItem(docA, conflicted, itemFrontier(docA), resolved)
    if (resolution !== null) docA.import(resolution)
    expect(renderItem(docA)).toBe(resolved)

    // Both devices sync again and re-render: the resolution must hold everywhere.
    docA.import(docB.export({ mode: "update" }))
    docB.import(docA.export({ mode: "update" }))
    expect(renderItem(docA)).toBe(resolved)
    expect(renderItem(docB)).toBe(resolved)

    // Re-capturing the resolved render is a no-op on both devices; 3 never comes back.
    expect(captureCurrent(docA, resolved)).toBeNull()
    expect(captureCurrent(docB, resolved)).toBeNull()
    expect(renderItem(docA)).toBe(resolved)
    expect(renderItem(docB)).toBe(resolved)
    docA.free()
    docB.free()
  })
})
