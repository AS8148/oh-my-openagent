import { describe, expect, test } from "bun:test"

import type { LoroDoc } from "../../crdt/loro-runtime"

import type { ItemDevice, ItemFrontier } from "./index"
import { parse as parseYaml } from "yaml"

import { captureOnDevice, createDeviceItemDoc, itemFrontier, recordMaterialized, renderItem } from "./index"
import { withDevices } from "./test-support"

// Reviews r3/r4 (oMo PR #10203): through the capture entry point, an edit is applied exactly
// once however the capture is replayed: identical double-fires, a crash followed by more
// typing, a crash before the update was imported, a synced edit written to disk before a
// crash, and an older baseline replayed after a newer one. A hand-resolved register conflict
// survives the next capture and a sync on both devices.

async function fire(device: ItemDevice, doc: LoroDoc, base: string, frontier: ItemFrontier, working: string): Promise<void> {
  const update = await captureOnDevice(device, "item.md", doc, base, frontier, working)
  if (update !== null) doc.import(update)
}

async function seeded(device: ItemDevice, text: string): Promise<LoroDoc> {
  const doc = await createDeviceItemDoc(device)
  await fire(device, doc, "", [], text)
  return doc
}

function fieldValue(rendered: string, key: string): unknown {
  if (!rendered.startsWith("---\n")) return undefined
  const end = rendered.indexOf("\n---", 4)
  const header: unknown = parseYaml(rendered.slice(4, end))
  return typeof header === "object" && header !== null ? Object.entries(header).find(([k]) => k === key)?.[1] : undefined
}

function fieldParts(rendered: string, key: string): string[] {
  const value = fieldValue(rendered, key)
  return value === undefined ? [] : String(value).split(" / ")
}

function sync(a: LoroDoc, b: LoroDoc): void {
  const ua = a.export({ mode: "update" })
  const ub = b.export({ mode: "update" })
  a.import(ub)
  b.import(ua)
}

describe("reviews r3/r4: capture through the device entry point applies each edit once", () => {
  test("an identical double-fire and a crash replay apply the body edit once", async () => {
    await withDevices(1, async ([device]) => {
      if (device === undefined) throw new Error("no device")
      const doc = await seeded(device, "line1\n")
      const f1 = itemFrontier(doc)
      await fire(device, doc, "line1\n", f1, "line1\nline2\n")
      expect(await captureOnDevice(device, "item.md", doc, "line1\n", f1, "line1\nline2\n")).toBeNull()
      expect(renderItem(doc)).toBe("line1\nline2\n")
      doc.free()
    })
  })

  test("a frontmatter double-fire does not duplicate the value", async () => {
    await withDevices(1, async ([device]) => {
      if (device === undefined) throw new Error("no device")
      const v1 = "---\ndescription: hi\n---\n"
      const doc = await seeded(device, v1)
      const f1 = itemFrontier(doc)
      const v2 = "---\ndescription: hi there\n---\n"
      await fire(device, doc, v1, f1, v2)
      await fire(device, doc, v1, f1, v2)
      expect(renderItem(doc)).toBe(v2)
      doc.free()
    })
  })

  test("a crash, then more typing, then N drifted replays from the old baseline apply every edit once", async () => {
    await withDevices(1, async ([device]) => {
      if (device === undefined) throw new Error("no device")
      const doc = await seeded(device, "hello\n")
      const f0 = itemFrontier(doc)
      let disk = "hello\n"
      for (const word of ["<A>", "<B>", "<C>", "<D>"]) {
        disk = `${disk}${word}\n`
        await fire(device, doc, "hello\n", f0, disk)
        await fire(device, doc, "hello\n", f0, disk)
      }
      expect(renderItem(doc)).toBe("hello\n<A>\n<B>\n<C>\n<D>\n")
      doc.free()
    })
  })

  test("a crash before the update was imported loses nothing and duplicates nothing", async () => {
    await withDevices(1, async ([device]) => {
      if (device === undefined) throw new Error("no device")
      const doc = await seeded(device, "base\n")
      const f0 = itemFrontier(doc)
      const dropped = await captureOnDevice(device, "item.md", doc, "base\n", f0, "base\n<A>\n")
      expect(dropped).not.toBeNull()
      await fire(device, doc, "base\n", f0, "base\n<A>\n<B>\n")
      expect(renderItem(doc)).toBe("base\n<A>\n<B>\n")
      doc.free()
    })
  })

  test("a synced edit written to disk, then a crash, then typing applies the synced edit once", async () => {
    await withDevices(2, async ([a, b]) => {
      if (a === undefined || b === undefined) throw new Error("no device")
      const docA = await seeded(a, "t\n")
      const docB = await createDeviceItemDoc(b)
      sync(docA, docB)
      const fB = itemFrontier(docB)
      await fire(a, docA, "t\n", itemFrontier(docA), "t\n<X>\n")
      sync(docA, docB)
      const written = renderItem(docB) ?? ""
      await recordMaterialized(b, "item.md", docB, fB, written)
      // B crashed before saving the new baseline; its user types on top of the written file.
      await fire(b, docB, "t\n", fB, `${written}<Y>\n`)
      sync(docA, docB)
      expect(renderItem(docB)).toBe("t\n<X>\n<Y>\n")
      expect(renderItem(docA)).toBe("t\n<X>\n<Y>\n")
      docA.free()
      docB.free()
    })
  })

  test("an older baseline replayed after a newer capture is a no-op", async () => {
    await withDevices(1, async ([device]) => {
      if (device === undefined) throw new Error("no device")
      const doc = await seeded(device, "x\n")
      const f0 = itemFrontier(doc)
      await fire(device, doc, "x\n", f0, "x\n<A>\n")
      await fire(device, doc, "x\n<A>\n", itemFrontier(doc), "x\n<A>\n<B>\n")
      expect(await captureOnDevice(device, "item.md", doc, "x\n", f0, "x\n<A>\n")).toBeNull()
      expect(renderItem(doc)).toBe("x\n<A>\n<B>\n")
      doc.free()
    })
  })

  test("a drifted register edit never splices values: an unseen concurrent value stays a conflict", async () => {
    await withDevices(2, async ([a, b]) => {
      if (a === undefined || b === undefined) throw new Error("no device")
      const seed = "---\nn: 1\nf: true\n---\nbody\n"
      const docA = await seeded(a, seed)
      const docB = await createDeviceItemDoc(b)
      sync(docA, docB)
      const f0 = itemFrontier(docB)
      await fire(a, docA, seed, itemFrontier(docA), "---\nn: 2\nf: false\n---\nbody\n")
      sync(docA, docB)
      // B's disk still shows the seed; it captures a body edit, crashes, then the user edits the registers.
      await fire(b, docB, seed, f0, "---\nn: 1\nf: true\n---\nbody\n<X>\n")
      await fire(b, docB, seed, f0, "---\nn: 3\nf: 0\n---\nbody\n<X>\n")
      sync(docA, docB)
      const rendered = renderItem(docB) ?? ""
      expect(renderItem(docA)).toBe(rendered)
      expect(fieldParts(rendered, "n").sort()).toEqual(["2", "3"])
      expect(fieldParts(rendered, "f").sort()).toEqual(["0", "false"])
      expect(rendered.split("<X>").length - 1).toBe(1)
      docA.free()
      docB.free()
    })
  })

  test("r5 H1: a register edited on two devices, then a drifted replay, holds only whole written values", async () => {
    await withDevices(3, async ([a, b, c]) => {
      if (a === undefined || b === undefined || c === undefined) throw new Error("no device")
      const seed = "---\nn: 1\n---\nbody\n"
      const docA = await seeded(a, seed)
      const docB = await createDeviceItemDoc(b)
      const docC = await createDeviceItemDoc(c)
      sync(docA, docB)
      sync(docA, docC)
      const fB = itemFrontier(docB)
      await fire(a, docA, seed, itemFrontier(docA), "---\nn: 2\n---\nbody\n")
      await fire(c, docC, seed, itemFrontier(docC), "---\nn: 3\n---\nbody\n")
      sync(docA, docC)
      sync(docA, docB)
      // B's disk still shows the seed: a body edit is captured, then the user edits n and the capture replays.
      await fire(b, docB, seed, fB, "---\nn: 1\n---\nbody\n<X>\n")
      await fire(b, docB, seed, fB, "---\nn: hello\n---\nbody\n<X>\n")
      sync(docA, docB)
      sync(docB, docC)
      const rendered = renderItem(docB) ?? ""
      expect(renderItem(docA)).toBe(rendered)
      expect(renderItem(docC)).toBe(rendered)
      for (const part of fieldParts(rendered, "n")) expect(["2", "3", "hello"], `spliced register part ${part}`).toContain(part)
      expect(rendered.split("<X>").length - 1).toBe(1)
      docA.free()
      docB.free()
      docC.free()
    })
  })

  test("lead r6: concurrent edits to a one-line string field keep two whole values, never a mix", async () => {
    await withDevices(2, async ([a, b]) => {
      if (a === undefined || b === undefined) throw new Error("no device")
      const seed = "---\ndescription: the bird sat\n---\n"
      const docA = await seeded(a, seed)
      const docB = await createDeviceItemDoc(b)
      sync(docA, docB)
      await fire(a, docA, seed, itemFrontier(docA), "---\ndescription: the red bird sat\n---\n")
      await fire(b, docB, seed, itemFrontier(docB), "---\ndescription: the bird sat down\n---\n")
      sync(docA, docB)
      const rendered = renderItem(docA) ?? ""
      expect(renderItem(docB)).toBe(rendered)
      expect(fieldParts(rendered, "description").sort()).toEqual(["the bird sat down", "the red bird sat"])
      docA.free()
      docB.free()
    })
  })

  test("r5 M1: a drifted list-to-string change replaces the seen elements by the whole string", async () => {
    await withDevices(2, async ([a, b]) => {
      if (a === undefined || b === undefined) throw new Error("no device")
      const seed = "---\ntags:\n  - a\n---\nbody\n"
      const docA = await seeded(a, seed)
      const docB = await createDeviceItemDoc(b)
      sync(docA, docB)
      const fB = itemFrontier(docB)
      await fire(a, docA, seed, itemFrontier(docA), "---\ntags:\n  - a\n  - c\n---\nbody\n")
      sync(docA, docB)
      await fire(b, docB, seed, fB, "---\ntags:\n  - a\n---\nbody\n<X>\n")
      await fire(b, docB, seed, fB, "---\ntags: 'x: y'\n---\nbody\n<X>\n")
      sync(docA, docB)
      const rendered = renderItem(docB) ?? ""
      expect(renderItem(docA)).toBe(rendered)
      const tags = fieldValue(rendered, "tags")
      expect(Array.isArray(tags)).toBe(true)
      expect(Array.isArray(tags) ? [...tags].map(String).sort() : []).toEqual(["c", "x: y"])
      docA.free()
      docB.free()
    })
  })

  test("r5 M2: a value written to disk before a crash is replaced cleanly by the user's edit", async () => {
    await withDevices(2, async ([a, b]) => {
      if (a === undefined || b === undefined) throw new Error("no device")
      const seed = "---\nn: 1\n---\n"
      const docA = await seeded(a, seed)
      const docB = await createDeviceItemDoc(b)
      sync(docA, docB)
      const fB = itemFrontier(docB)
      await fire(a, docA, seed, itemFrontier(docA), "---\nn: 2\n---\n")
      sync(docA, docB)
      const written = renderItem(docB) ?? ""
      await recordMaterialized(b, "item.md", docB, fB, written)
      await fire(b, docB, seed, fB, "---\nn: 5\n---\n")
      sync(docA, docB)
      expect(renderItem(docB)).toBe("---\nn: 5\n---\n")
      expect(renderItem(docA)).toBe("---\nn: 5\n---\n")
      docA.free()
      docB.free()
    })
  })

  test("a hand-resolved register conflict survives the next capture and sync on both devices", async () => {
    await withDevices(2, async ([a, b]) => {
      if (a === undefined || b === undefined) throw new Error("no device")
      const docA = await seeded(a, "---\nn: 2\n---\n")
      const docB = await seeded(b, "---\nn: 3\n---\n")
      sync(docA, docB)
      const conflicted = renderItem(docA) ?? ""
      expect(renderItem(docB)).toBe(conflicted)
      expect(conflicted).toContain("2 / 3")
      const resolved = "---\nn: 2\n---\n"
      await fire(a, docA, conflicted, itemFrontier(docA), resolved)
      expect(renderItem(docA)).toBe(resolved)
      sync(docA, docB)
      expect(renderItem(docB)).toBe(resolved)
      expect(await captureOnDevice(a, "item.md", docA, resolved, itemFrontier(docA), resolved)).toBeNull()
      expect(await captureOnDevice(b, "item.md", docB, resolved, itemFrontier(docB), resolved)).toBeNull()
      docA.free()
      docB.free()
    })
  })
})
