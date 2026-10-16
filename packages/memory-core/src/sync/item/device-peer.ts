// The device's one Loro peer id (review r3): created once, persisted, and reused by every
// capture on this device, so the version vector holds one entry per device. Creation is an
// exclusive create (`wx`): when two processes race, exactly one id is written and both read it.

import { randomBytes } from "node:crypto"
import { dirname } from "node:path"

import type { PeerID } from "../../crdt/loro-runtime"
import { mkdir, readFile, writeFile } from "../../fs/resilient"

export class DevicePeerError extends Error {
  override readonly name = "DevicePeerError"
}

const PEER_RE = /^[1-9][0-9]{0,19}$/
const U64_MAX = (1n << 64n) - 1n

export async function loadOrCreateDevicePeer(path: string): Promise<PeerID> {
  const existing = await readPeer(path)
  if (existing !== null) return existing
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(path, `${freshPeer()}\n`, { flag: "wx", mode: 0o600 })
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
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
