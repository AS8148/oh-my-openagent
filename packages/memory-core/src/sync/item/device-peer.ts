// The device's one Loro peer id (review r3): created once, persisted, and reused by every
// capture on this device, so the version vector holds one entry per device. `path` is a
// directory holding the file `id`. The id is written whole into a private candidate directory,
// which is published by renaming it onto `path`: a directory rename is atomic and fails when
// the target exists and is non-empty, on every file system (no hard links, review r4 LOW-2).
// A racing reader never sees a partial id, and exactly one candidate wins.

import { randomBytes } from "node:crypto"
import { dirname, join } from "node:path"

import type { PeerID } from "../../crdt/loro-runtime"
import { mkdir, readFile, rename, rm, writeFile } from "../../fs/resilient"

export class DevicePeerError extends Error {
  override readonly name = "DevicePeerError"
}

const PEER_RE = /^[1-9][0-9]{0,19}$/
const U64_MAX = (1n << 64n) - 1n

export async function loadOrCreateDevicePeer(path: string): Promise<PeerID> {
  const existing = await readPeer(path)
  if (existing !== null) return existing
  await mkdir(dirname(path), { recursive: true })
  const candidate = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  await mkdir(candidate, { mode: 0o700 })
  let lost: unknown = null
  try {
    await writeFile(join(candidate, "id"), `${freshPeer()}\n`, { flag: "wx", mode: 0o600 })
    await rename(candidate, path)
  } catch (error) {
    lost = error
  } finally {
    await rm(candidate, { recursive: true, force: true })
  }
  const created = await readPeer(path)
  if (created !== null) return created
  throw lost ?? new DevicePeerError(`device peer vanished after create: ${path}`)
}

async function readPeer(path: string): Promise<PeerID | null> {
  let raw: string
  try {
    raw = await readFile(join(path, "id"), "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  }
  const text = raw.trim()
  if (!isPeer(text)) throw new DevicePeerError(`device peer file is not a u64 peer id: ${path}`)
  return text
}

function freshPeer(): string {
  let value = 0n
  while (value === 0n) value = randomBytes(8).readBigUInt64BE()
  return value.toString()
}

function isPeer(text: string): text is PeerID {
  return PEER_RE.test(text) && BigInt(text) <= U64_MAX
}
