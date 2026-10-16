import { describe, expect, test } from "bun:test"

import type { LoroDoc } from "../../crdt/loro-runtime"

import type { ItemFrontier } from "./index"
import { captureItem, itemFrontier, renderItem } from "./index"
import { captureCurrent, mulberry32, newDoc } from "./test-support"

// review r3 property (oMo PR #10203): over 2000 seeded scripts mixing fresh edits,
// crash-window replays of the same capture, stale edits from an older baseline, and
// cross-syncs between two devices —
//   (a) the final document is identical regardless of how many times a state is re-captured,
//   (b) every distinct edit appears exactly once after the merge, and
//   (c) the version vector holds exactly one peer per device.
// Seeds are fixed (0..1999); a failing seed is printed and named in the assertion message.

interface Capture {
  readonly base: string
  readonly frontier: ItemFrontier
  readonly working: string
}

interface Device {
  readonly doc: LoroDoc
  readonly log: Capture[]
}

const SEEDS = 2000

function bodyAppend(text: string, marker: string): string {
  return text === "" || text.endsWith("\n") ? `${text}${marker}\n` : `${text}\n${marker}\n`
}

function fmAdd(text: string, key: string, marker: string): string {
  const headerEnd = text.startsWith("---\n") ? text.indexOf("\n---\n", 3) : -1
  if (headerEnd < 0) return `---\n${key}: ${marker}\n---\n${text}`
  return `${text.slice(0, headerEnd)}\n${key}: ${marker}${text.slice(headerEnd)}`
}

// Markers are bracketed so one never occurs inside another (s0e1 is a prefix of s0e10).
function edit(rand: () => number, text: string, marker: string, counter: number): string {
  return rand() < 0.3 ? fmAdd(text, `k${counter}`, marker) : bodyAppend(text, marker)
}

function fire(device: Device, base: string, frontier: ItemFrontier, working: string): void {
  const update = captureItem(device.doc, base, frontier, working)
  if (update !== null) device.doc.import(update)
  device.log.push({ base, frontier, working })
}

function sync(a: Device, b: Device): void {
  const ua = a.doc.export({ mode: "update" })
  const ub = b.doc.export({ mode: "update" })
  a.doc.import(ub)
  b.doc.import(ua)
}

async function runSeed(seed: number): Promise<void> {
  const rand = mulberry32(seed)
  const a: Device = { doc: await newDoc("1"), log: [] }
  const b: Device = { doc: await newDoc("2"), log: [] }
  const markers: string[] = []
  let counter = 0
  try {
    // Both devices capture at least once, so both peers enter the version vector.
    for (const device of [a, b]) {
      const marker = `<s${seed}i${counter}>`
      counter += 1
      markers.push(marker)
      const current = renderItem(device.doc) ?? ""
      fire(device, current, itemFrontier(device.doc), bodyAppend(current, marker))
    }
    sync(a, b)
    const steps = 6 + Math.floor(rand() * 8)
    for (let step = 0; step < steps; step++) {
      const device = rand() < 0.5 ? a : b
      const other = device === a ? b : a
      const roll = rand()
      const last = device.log[device.log.length - 1]
      if (roll < 0.3 && last !== undefined && renderItem(device.doc) === last.working) {
        // Crash window / double-fire: the same capture fires again before anything moved.
        const replay = captureItem(device.doc, last.base, last.frontier, last.working)
        expect(replay, `seed ${seed} step ${step}: identical replay minted new ops`).toBeNull()
      } else if (roll < 0.5 && device.log.length > 1) {
        // Stale edit: the device edits from an older baseline it still has on disk.
        const stale = device.log[Math.floor(rand() * (device.log.length - 1))]
        if (stale === undefined) throw new Error("stale pick: hole")
        const marker = `<s${seed}s${counter}>`
        markers.push(marker)
        fire(device, stale.base, stale.frontier, edit(rand, stale.base, marker, counter))
        counter += 1
      } else if (roll < 0.75) {
        const marker = `<s${seed}e${counter}>`
        markers.push(marker)
        const current = renderItem(device.doc) ?? ""
        fire(device, current, itemFrontier(device.doc), edit(rand, current, marker, counter))
        counter += 1
      } else {
        sync(device, other)
      }
    }
    sync(a, b)
    const renderA = renderItem(a.doc) ?? ""
    const renderB = renderItem(b.doc) ?? ""
    expect(renderB, `seed ${seed}: devices diverged`).toBe(renderA)
    for (const marker of markers) {
      const count = renderA.split(marker).length - 1
      expect(count, `seed ${seed}: marker ${marker} appears ${count} times`).toBe(1)
    }
    // Re-capturing the settled render is a no-op on both devices.
    expect(captureCurrent(a.doc, renderA), `seed ${seed}: settled re-capture on A minted ops`).toBeNull()
    expect(captureCurrent(b.doc, renderA), `seed ${seed}: settled re-capture on B minted ops`).toBeNull()
    // One peer per device in the version vector, no matter how many captures ran.
    const peers = [...a.doc.oplogVersion().toJSON().keys()].sort()
    expect(peers, `seed ${seed}: version vector peers ${JSON.stringify(peers)}`).toEqual(["1", "2"])
  } finally {
    a.doc.free()
    b.doc.free()
  }
}

// 2000 seeds in 8 shards so each stays inside the repo's 30s heavy-test bound.
const SHARD = 250

describe("review r3: capture idempotence property", () => {
  for (let start = 0; start < SEEDS; start += SHARD) {
    test(`seeds ${start}..${start + SHARD - 1} keep captures idempotent, lossless and single-peer`, async () => {
      for (let seed = start; seed < start + SHARD; seed++) {
        try {
          await runSeed(seed)
        } catch (error) {
          console.error(`r3 property failing seed: ${seed}`)
          throw error
        }
      }
    }, 30_000)
  }
})
