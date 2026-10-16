import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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

  test("#given 16 concurrent first loads #when they race #then all return the same id", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "peer")
      const ids = await Promise.all(Array.from({ length: 16 }, () => loadOrCreateDevicePeer(path)))
      expect(new Set(ids).size).toBe(1)
    })
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
