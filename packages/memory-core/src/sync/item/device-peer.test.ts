import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DevicePeerError, loadOrCreateDevicePeer } from "./device-peer"

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "device-peer-"))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("loadOrCreateDevicePeer", () => {
  test("#given no peer file #when loaded twice #then one id is created, persisted and reused", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "nested", "peer")
      const first = await loadOrCreateDevicePeer(path)
      const second = await loadOrCreateDevicePeer(path)
      expect(second).toBe(first)
      expect((await readFile(path, "utf8")).trim()).toBe(first)
      expect(BigInt(first) > 0n).toBe(true)
    })
  })

  test("#given 64 concurrent first loads #when they race #then all read one complete id and no candidate is left", async () => {
    for (let round = 0; round < 20; round++) {
      await withDir(async (dir) => {
        const path = join(dir, "peer")
        const ids = await Promise.all(Array.from({ length: 64 }, () => loadOrCreateDevicePeer(path)))
        expect(new Set(ids).size, `round ${round}`).toBe(1)
        expect(await readdir(dir), `round ${round}`).toEqual(["peer"])
      })
    }
  })

  test("#given a corrupt peer file #when loaded #then it throws instead of minting a second identity", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "peer")
      await writeFile(path, "not-a-peer\n")
      await expect(loadOrCreateDevicePeer(path)).rejects.toBeInstanceOf(DevicePeerError)
      await writeFile(path, `${(1n << 64n).toString()}\n`)
      await expect(loadOrCreateDevicePeer(path)).rejects.toBeInstanceOf(DevicePeerError)
    })
  })
})
