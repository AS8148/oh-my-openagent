import { isMemoryExpired } from "../memfs/expiry"
import type { MemoryExpiry } from "./compile"

/**
 * The part of the clock a compiled block depends on: which of its revision's `expires` instants have passed. Two
 * instants with the same slot compile to the same bytes, so a block is cached per (revision, slot).
 */
export function expirySlot(expiries: readonly MemoryExpiry[], asOfMs: number): string {
  return expiries
    .filter((expiry) => isMemoryExpired(expiry.expiresAtMs, asOfMs))
    .map((expiry) => `${expiry.path}@${expiry.expiresAtMs}`)
    .sort()
    .join("|")
}

/** A persisted block with the slot it was compiled in and every instant its revision declares. */
export interface StoredBlock {
  readonly block: string
  readonly slot: string
  readonly expiries: readonly MemoryExpiry[]
}

export function encodeStoredBlock({ block, slot, expiries }: StoredBlock): string {
  return JSON.stringify({ block, slot, expiries: expiries.map(({ path, expiresAtMs }) => [path, expiresAtMs]) })
}

/** A stored block, or `undefined` when the entry is not readable as one (it is then recompiled and rewritten). */
export function decodeStoredBlock(text: string): StoredBlock | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null || !("block" in value) || !("slot" in value) || !("expiries" in value)) {
    return undefined
  }
  const { block, slot, expiries: rawExpiries } = value
  if (typeof block !== "string" || typeof slot !== "string" || !Array.isArray(rawExpiries)) return undefined
  const expiries: MemoryExpiry[] = []
  for (const item of rawExpiries) {
    if (!Array.isArray(item) || typeof item[0] !== "string" || typeof item[1] !== "number" || !Number.isFinite(item[1])) {
      return undefined
    }
    expiries.push({ path: item[0], expiresAtMs: item[1] })
  }
  return { block, slot, expiries }
}
