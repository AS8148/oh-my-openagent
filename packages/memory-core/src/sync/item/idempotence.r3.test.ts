import { describe, expect, test } from "bun:test"

import type { LoroDoc } from "../../crdt/loro-runtime"

import { renderEntry } from "./frontmatter"
import type { FmValue, ItemDevice, ItemFrontier } from "./index"
import { captureOnDevice, createDeviceItemDoc, itemFrontier, recordMaterialized, renderItem, splitItem } from "./index"
import { mulberry32, newDoc, withDevices } from "./test-support"

// Reviews r3-r5 property (oMo PR #10203), over a model of the sync engine with 3 devices.
// Each device has a doc, a file on disk and the baseline it last saved. The user edits typed
// fields concurrently on every device: a register (`n`), a text field (`description`), a set
// (`tags`) and the body. The engine captures disk against the saved baseline, double-fires,
// syncs, and materialises (receipt, write, save baseline), with crashes before the write or
// between the write and the baseline save, so drifted replays and synced writes without a
// baseline happen all the time. For every seed: all devices converge, all 6 delivery orders
// of the devices' updates into a fresh doc render the same bytes, every typed marker appears exactly once,
// every register component is a value some device wrote (never a spliced string), a settled
// re-capture is a no-op, and the version vector holds only device peers.

const SEEDS = 2000
const SHARD = 125
const ITEM = "item.md"

interface Node {
  readonly device: ItemDevice
  readonly doc: LoroDoc
  disk: string
  saved: { text: string; frontier: ItemFrontier }
}

interface Ledger {
  readonly markers: string[]
  readonly registers: Set<string>
}

function edit(rand: () => number, disk: string, ledger: Ledger, seed: number): string {
  const parsed = splitItem(disk)
  const fields = new Map<string, FmValue>((parsed.fm ?? []).map((e) => [e.key, e.value]))
  const body = parsed.fm === null ? disk : parsed.body
  const id = ledger.markers.length + ledger.registers.size
  const roll = rand()
  let nextBody = body
  if (roll < 0.25) {
    const value = `${seed * 1000 + id + 1}`
    ledger.registers.add(value)
    fields.set("n", { kind: "reg", value })
  } else {
    const marker = `m${seed}x${id}q`
    ledger.markers.push(marker)
    if (roll < 0.45) {
      const old = fields.get("description")
      const text = old?.kind === "text" ? old.text : ""
      fields.set("description", { kind: "text", text: text === "" ? marker : `${text} ${marker}` })
    } else if (roll < 0.65) {
      const old = fields.get("tags")
      const elements = old?.kind === "set" ? old.elements : []
      fields.set("tags", { kind: "set", elements: [...elements, marker], flow: "" })
    } else {
      nextBody = body === "" || body.endsWith("\n") ? `${body}${marker}\n` : `${body}\n${marker}\n`
    }
  }
  const lines: string[] = []
  for (const [key, value] of fields) {
    if (value.kind === "reg") lines.push(renderEntry(key, value.value, true))
    else if (value.kind === "text") lines.push(renderEntry(key, value.text))
    else if (value.kind === "set") lines.push(renderEntry(key, value.elements))
  }
  return lines.length === 0 ? nextBody : `---\n${lines.join("\n")}\n---\n${nextBody}`
}

async function capture(node: Node): Promise<void> {
  const update = await captureOnDevice(node.device, ITEM, node.doc, node.saved.text, node.saved.frontier, node.disk)
  if (update !== null) node.doc.import(update)
}

async function materialise(node: Node, crash: "none" | "before-write" | "after-write"): Promise<void> {
  await capture(node)
  if (crash === "before-write") return
  const written = renderItem(node.doc) ?? ""
  await recordMaterialized(node.device, ITEM, node.doc, node.saved.frontier, written)
  node.disk = written
  if (crash === "after-write") return
  node.saved = { text: written, frontier: itemFrontier(node.doc) }
}

function sync(a: Node, b: Node): void {
  const ua = a.doc.export({ mode: "update" })
  const ub = b.doc.export({ mode: "update" })
  a.doc.import(ub)
  b.doc.import(ua)
}

function registerParts(rendered: string): string[] {
  const value = (splitItem(rendered).fm ?? []).find((e) => e.key === "n")?.value
  if (value === undefined || value.kind === "remove") return []
  const text = value.kind === "reg" ? value.value : value.kind === "text" ? value.text : value.elements.join(" / ")
  return text.split(" / ")
}

async function runSeed(seed: number, devices: readonly ItemDevice[]): Promise<void> {
  const rand = mulberry32(seed)
  const nodes: Node[] = []
  for (const device of devices) {
    nodes.push({ device, doc: await createDeviceItemDoc(device), disk: "", saved: { text: "", frontier: [] } })
  }
  const pick = (): Node => nodes[Math.floor(rand() * nodes.length)] ?? nodes[0] ?? fail()
  const ledger: Ledger = { markers: [], registers: new Set() }
  try {
    const steps = 10 + Math.floor(rand() * 12)
    for (let step = 0; step < steps; step++) {
      const node = pick()
      const roll = rand()
      if (roll < 0.4) node.disk = edit(rand, node.disk, ledger, seed)
      else if (roll < 0.52) await capture(node)
      else if (roll < 0.6) {
        await capture(node)
        await capture(node)
      } else if (roll < 0.82) {
        const crash = rand()
        await materialise(node, crash < 0.25 ? "before-write" : crash < 0.5 ? "after-write" : "none")
      } else sync(node, pick())
    }
    for (let round = 0; round < 2; round++) {
      for (const node of nodes) await materialise(node, "none")
      for (const a of nodes) for (const b of nodes) if (a !== b) sync(a, b)
    }
    for (const node of nodes) await materialise(node, "none")
    const rendered = renderItem(nodes[0]?.doc ?? fail()) ?? ""
    for (const node of nodes) expect(renderItem(node.doc) ?? "", `seed ${seed}: devices diverged`).toBe(rendered)
    const exports = nodes.map((node) => node.doc.export({ mode: "update" }))
    for (const order of permutations(exports.length)) {
      const fresh = await newDoc("9")
      for (const index of order) fresh.import(exports[index] ?? fail())
      expect(renderItem(fresh) ?? "", `seed ${seed}: delivery order ${order.join("")} diverged`).toBe(rendered)
      fresh.free()
    }
    for (const marker of ledger.markers) {
      const count = rendered.split(marker).length - 1
      expect(count, `seed ${seed}: marker ${marker} appears ${count} times`).toBe(1)
    }
    for (const part of registerParts(rendered)) {
      expect(ledger.registers.has(part), `seed ${seed}: register holds ${JSON.stringify(part)}, never written`).toBe(true)
    }
    for (const node of nodes) {
      const again = await captureOnDevice(node.device, ITEM, node.doc, node.saved.text, node.saved.frontier, node.disk)
      expect(again, `seed ${seed}: settled re-capture minted ops`).toBeNull()
    }
    const devicePeers = new Set<string>(devices.map((d) => d.peer))
    const foreign = [...(nodes[0]?.doc ?? fail()).oplogVersion().toJSON().keys()].filter((peer) => !devicePeers.has(peer))
    expect(foreign, `seed ${seed}: version vector holds non-device peers`).toEqual([])
  } finally {
    for (const node of nodes) node.doc.free()
  }
}

function permutations(n: number): number[][] {
  if (n === 0) return [[]]
  return permutations(n - 1).flatMap((rest) => Array.from({ length: n }, (_, at) => [...rest.slice(0, at), n - 1, ...rest.slice(at)]))
}

function fail(): never {
  throw new Error("three devices expected")
}

describe("reviews r3-r5: typed-field capture property over a 3-device engine model", () => {
  for (let start = 0; start < SEEDS; start += SHARD) {
    test(`seeds ${start}..${start + SHARD - 1}: concurrent register/text/set/body edits converge, once, unspliced`, async () => {
      for (let seed = start; seed < start + SHARD; seed++) {
        try {
          await withDevices(3, (devices) => runSeed(seed, devices))
        } catch (error) {
          console.error(`r5 property failing seed: ${seed}`)
          throw error
        }
      }
    }, 120_000)
  }
})
