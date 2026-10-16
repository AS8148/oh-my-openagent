// The device's one Loro peer id (review r3): created once, persisted, and reused by every
// capture on this device, so the version vector holds one entry per device. The id is written
// whole to a private temp file and published with link(2), which is atomic and fails when the
// file exists: a racing reader never sees a partial id, and exactly one candidate wins.

import { randomBytes } from "node:crypto"
import { dirname } from "node:path"

import type { PeerID } from "../../crdt/loro-runtime"
import { link, mkdir, readFile, unlink, writeFile } from "../../fs/resilient"

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
  await writeFile(candidate, `${freshPeer()}\n`, { flag: "wx", mode: 0o600 })
  try {
    await link(candidate, path)
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
  } finally {
    await unlink(candidate)
  }
  const created = await readPeer(path)
  if (created === null) throw new DevicePeerError(`device peer file vanished after create: ${path}`)
  return created
}

async function readPeer(path: string): Promise<PeerID | null> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
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
