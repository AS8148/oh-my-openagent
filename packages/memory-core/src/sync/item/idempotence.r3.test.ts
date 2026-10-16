import { describe, expect, test } from "bun:test"

import type { LoroDoc } from "../../crdt/loro-runtime"

import type { ItemDevice, ItemFrontier } from "./index"
import { captureOnDevice, createDeviceItemDoc, itemFrontier, recordMaterialized, renderItem } from "./index"
import { mulberry32, withDevices } from "./test-support"

// Reviews r3/r4 property (oMo PR #10203), over a model of the sync engine. Each device has a
// doc, a file on disk, and the baseline it last saved. Steps: the user types (a body line or a
// new frontmatter key), the engine captures disk against the saved baseline, the same capture
// fires again, the devices sync, and the engine materialises (receipt, write the file, save the
// baseline). A crash can strike before the write or between the write and the baseline save,
// so later typing turns into drifted replays from a stale baseline and synced text reaches
// disk without a baseline. For every seed: the devices converge, every typed marker appears
// exactly once, re-capturing the settled file is a no-op, and the version vector holds one
// peer per device. Seeds are fixed (0..1999); a failing seed is printed and named.

const SEEDS = 2000
const SHARD = 250
const ITEM = "item.md"

interface Node {
  readonly device: ItemDevice
  readonly doc: LoroDoc
  disk: string
  saved: { text: string; frontier: ItemFrontier }
}

function typeMarker(rand: () => number, text: string, marker: string, key: string): string {
  if (rand() < 0.3) {
    const headerEnd = text.startsWith("---\n") ? text.indexOf("\n---\n", 3) : -1
    if (headerEnd < 0) return `---\n${key}: ${marker}\n---\n${text}`
    return `${text.slice(0, headerEnd)}\n${key}: ${marker}${text.slice(headerEnd)}`
  }
  return text === "" || text.endsWith("\n") ? `${text}${marker}\n` : `${text}\n${marker}\n`
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

async function runSeed(seed: number, devices: readonly ItemDevice[]): Promise<void> {
  const rand = mulberry32(seed)
  const nodes: Node[] = []
  for (const device of devices) {
    nodes.push({ device, doc: await createDeviceItemDoc(device), disk: "", saved: { text: "", frontier: [] } })
  }
  const [a, b] = nodes
  if (a === undefined || b === undefined) throw new Error("two devices expected")
  const markers: string[] = []
  try {
    const steps = 8 + Math.floor(rand() * 10)
    for (let step = 0; step < steps; step++) {
      const node = rand() < 0.5 ? a : b
      const roll = rand()
      if (roll < 0.35) {
        const marker = `<s${seed}m${markers.length}>`
        node.disk = typeMarker(rand, node.disk, marker, `k${markers.length}`)
        markers.push(marker)
      } else if (roll < 0.5) {
        await capture(node)
      } else if (roll < 0.6) {
        await capture(node)
        await capture(node)
      } else if (roll < 0.8) {
        const crash = rand()
        await materialise(node, crash < 0.25 ? "before-write" : crash < 0.5 ? "after-write" : "none")
      } else {
        sync(a, b)
      }
    }
    for (let round = 0; round < 2; round++) {
      for (const node of nodes) await materialise(node, "none")
      sync(a, b)
    }
    for (const node of nodes) await materialise(node, "none")
    const rendered = renderItem(a.doc) ?? ""
    expect(renderItem(b.doc) ?? "", `seed ${seed}: devices diverged`).toBe(rendered)
    for (const marker of markers) {
      const count = rendered.split(marker).length - 1
      expect(count, `seed ${seed}: marker ${marker} appears ${count} times`).toBe(1)
    }
    for (const node of nodes) {
      const again = await captureOnDevice(node.device, ITEM, node.doc, node.saved.text, node.saved.frontier, node.disk)
      expect(again, `seed ${seed}: settled re-capture minted ops`).toBeNull()
    }
    // A device that never typed writes no ops, so the vector holds at most one peer per device.
    const devicePeers = new Set<string>(devices.map((d) => d.peer))
    const foreign = [...a.doc.oplogVersion().toJSON().keys()].filter((peer) => !devicePeers.has(peer))
    expect(foreign, `seed ${seed}: version vector holds non-device peers`).toEqual([])
  } finally {
    for (const node of nodes) node.doc.free()
  }
}

describe("reviews r3/r4: capture idempotence property over an engine model", () => {
  for (let start = 0; start < SEEDS; start += SHARD) {
    test(`seeds ${start}..${start + SHARD - 1}: crashes, drifted replays and synced writes apply each edit once`, async () => {
      for (let seed = start; seed < start + SHARD; seed++) {
        try {
          await withDevices(2, (devices) => runSeed(seed, devices))
        } catch (error) {
          console.error(`r4 property failing seed: ${seed}`)
          throw error
        }
      }
    }, 60_000)
  }
})
