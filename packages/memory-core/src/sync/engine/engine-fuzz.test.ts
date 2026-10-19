import { afterEach, expect, test } from "bun:test"

import { CrashInjected, INBOUND_POINTS } from "./engine"
import { type Device, GIT_TEST_TIMEOUT, makeDevice } from "./engine-harness.test-support"
import { FakeSyncServer } from "./fake-server.test-support"

// Seeded random create/edit/delete/interrupt runs on two devices, with crashes at every inbound
// point (mid-render included) followed by edits. With deletes, both devices must converge and no
// cycle may stay stuck. Without deletes, every line ever written must also survive. On the Loro
// store the devices must agree byte for byte, every written line must be on disk (a conflict
// copy counts) and no file may hold a line twice.

const devices: Device[] = []
afterEach(async () => {
  for (const d of devices.splice(0)) await d.dispose()
}, GIT_TEST_TIMEOUT)

function prng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FILES = ["a.md", "b.md", "notes/c.md"]
const STEPS = 24

async function run(seed: number, deletes: boolean, realStore = false) {
  const random = prng(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)] as T
  const server = new FakeSyncServer()
  const pair = [await makeDevice(server, "a", undefined, { realStore }), await makeDevice(server, "b", undefined, { realStore })]
  devices.push(...pair)
  const written = new Map<string, Set<string>>()
  let line = 0
  for (let step = 0; step < STEPS; step += 1) {
    const device = pick(pair)
    const roll = random()
    if (roll < 0.45) {
      const file = pick(FILES)
      const text = `line-${seed}-${(line += 1)}`
      const current = (await device.read(file)) ?? ""
      await device.write(file, `${current}${text}\n`)
      written.set(file, (written.get(file) ?? new Set()).add(text))
    } else if (roll < 0.55 && deletes) {
      await device.write(pick(FILES), null)
    } else if (roll < 0.7) {
      const point = pick(INBOUND_POINTS)
      await device.restart((at) => {
        if (at === point) throw new CrashInjected(point)
      })
      await device.engine.runCycle().catch((error: unknown) => {
        if (!(error instanceof CrashInjected)) throw error
      })
      await device.restart()
    } else {
      await device.engine.runCycle()
    }
  }
  for (let round = 0; round < 3; round += 1) for (const device of pair) await device.engine.runCycle()
  const [a, b] = pair as [Device, Device]
  if (realStore) {
    const files = await a.workingFiles()
    expect(await b.workingFiles()).toEqual(files)
    const all: string[] = []
    for (const file of files) {
      const text = (await a.read(file)) ?? ""
      expect([file, await b.read(file)]).toEqual([file, text])
      const lines = text.split("\n").filter((l) => l !== "")
      expect([file, lines.length]).toEqual([file, new Set(lines).size])
      all.push(...lines)
    }
    for (const lines of written.values()) for (const l of lines) expect([l, all.includes(l)]).toEqual([l, true])
    for (const device of pair) expect((await device.engine.state()).cycle).toBeNull()
    return
  }
  // The fake store is a line set: a device's own unrendered edit keeps its local line order, so
  // convergence is equal line sets, not equal bytes.
  const lines = (text: string | null) => (text ?? "").split("\n").filter((l) => l !== "").sort()
  for (const file of FILES) expect([file, lines(await a.read(file))]).toEqual([file, lines(await b.read(file))])
  for (const device of pair) expect((await device.engine.state()).cycle).toBeNull()
  if (!deletes) {
    // A line may live in its file or in a conflict copy made for an edit during an interrupted sync.
    let disk = ""
    for (const file of await a.workingFiles()) disk += `${(await a.read(file)) ?? ""}\n`
    for (const lines of written.values()) for (const l of lines) expect([l, disk.includes(l)]).toEqual([l, true])
  }
}

for (const seed of [1, 2, 3]) {
  test(`seed ${seed}: random create/edit/delete/interrupt runs converge with no stuck cycle`, () => run(seed, true), 120_000)
  test(`seed ${seed}: random write/interrupt runs converge and lose no written line`, () => run(seed + 100, false), 120_000)
}

for (const seed of [11, 12, 13, 14, 15, 16, 17, 18]) {
  test(`Loro store, seed ${seed}: random write/interrupt runs agree byte for byte, keep every line and duplicate none`, () => run(seed, false, true), 180_000)
}
