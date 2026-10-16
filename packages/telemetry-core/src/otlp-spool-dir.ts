import { linkSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs"
import { rename } from "node:fs/promises"
import { join } from "node:path"

import { countSpoolRecords, type Signal } from "./otlp-spool-file"

export type DropReason = "evicted" | "expired" | "rejected" | "corrupt"

export const SPOOL_CAP_BYTES = 5 * 1024 * 1024
export const SPOOL_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
export const CLAIM_LEASE_MS = 5 * 60 * 1000
export const DEAD_OWNER_IDLE_MS = 300_000

export type SpoolContext = {
  readonly dir: string
  readonly bootId: string
  readonly pid: number
  readonly nowMs: () => number
  readonly isPidAlive: (pid: number) => boolean
  readonly capBytes: number
  readonly maxAgeMs: number
  readonly onDrop: (reason: DropReason, records: number) => void
}

export type SpoolEntry =
  | { readonly kind: "active"; readonly name: string; readonly signal: Signal; readonly pid: number; readonly bootId: string }
  | { readonly kind: "batch"; readonly name: string; readonly signal: Signal; readonly batchId: string }
  | {
    readonly kind: "sending"
    readonly name: string
    readonly signal: Signal
    readonly batchId: string
    readonly claimer: string
    readonly leaseExpiresMs: number
  }
  | { readonly kind: "other"; readonly name: string }

const ACTIVE = /^active-(logs|traces)-([0-9]+)-([0-9a-f]{32})\.otlp$/
const BATCH = /^batch-(logs|traces)-([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12})\.otlp$/
const SENDING =
  /^batch-(logs|traces)-([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12})\.sending-([0-9a-f]{32})-([0-9]+)$/

function signalOf(value: string | undefined): Signal {
  return value === "traces" ? "traces" : "logs"
}

export function parseSpoolName(name: string): SpoolEntry {
  const active = ACTIVE.exec(name)
  if (active !== null) {
    return { kind: "active", name, signal: signalOf(active[1]), pid: Number(active[2]), bootId: active[3] ?? "" }
  }
  const batch = BATCH.exec(name)
  if (batch !== null) return { kind: "batch", name, signal: signalOf(batch[1]), batchId: batch[2] ?? "" }
  const sending = SENDING.exec(name)
  if (sending !== null) {
    return {
      kind: "sending",
      name,
      signal: signalOf(sending[1]),
      batchId: sending[2] ?? "",
      claimer: sending[3] ?? "",
      leaseExpiresMs: Number(sending[4]),
    }
  }
  return { kind: "other", name }
}

export const activeName = (signal: Signal, pid: number, bootId: string): string =>
  `active-${signal}-${pid}-${bootId}.otlp`
export const batchName = (signal: Signal, batchId: string): string => `batch-${signal}-${batchId}.otlp`
const sendingName = (signal: Signal, batchId: string, bootId: string, leaseExpiresMs: number): string =>
  `batch-${signal}-${batchId}.sending-${bootId}-${leaseExpiresMs}`

const HEX = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(2, "0"))

const COUNTER_BITS = 26
const COUNTER_LIMIT = 2 ** COUNTER_BITS
let lastIdMs = -1
let lastCounter = 0
let lastCounterOverflowed = false

/**
 * UUIDv7 (RFC 9562) with a fixed-length dedicated counter (section 6.2, method 1): 48-bit unix
 * milliseconds, version 7, then a 26-bit counter in rand_a (12 bits) and the top 14 bits of rand_b
 * after the variant, then random bits. Repeated calls for the same millisecond increment the
 * counter, so ids sort in creation order and the send and eviction order equals the seal order. Any
 * other millisecond reseeds the counter with a random value whose top bit is 0, leaving at least
 * 2^25 increments; a recovered file's id therefore keeps its own (older) creation time. An
 * exhausted counter moves the timestamp one millisecond forward, as the RFC allows. Never sent.
 */
export function createBatchId(unixMs: number): string {
  const ms = Math.max(0, Math.floor(unixMs))
  if (ms === lastIdMs || (ms === lastIdMs - 1 && lastCounterOverflowed)) {
    lastCounter += 1
    if (lastCounter >= COUNTER_LIMIT) {
      lastIdMs += 1
      lastCounter = 0
      lastCounterOverflowed = true
    }
  } else {
    lastIdMs = ms
    lastCounter = Math.floor(Math.random() * (COUNTER_LIMIT / 2))
    lastCounterOverflowed = false
  }
  let timestamp = lastIdMs
  const counter = lastCounter
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp % 256
    timestamp = Math.floor(timestamp / 256)
  }
  // counter bits 25..14 -> rand_a (12 bits); bits 13..8 -> byte 8 after the variant; bits 7..0 -> byte 9
  bytes[6] = 0x70 | ((counter >>> 22) & 0x0f)
  bytes[7] = (counter >>> 14) & 0xff
  bytes[8] = 0x80 | ((counter >>> 8) & 0x3f)
  bytes[9] = counter & 0xff
  const hex = Array.from(bytes, (byte) => HEX[byte] ?? "00").join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Fixed-width lowercase hex ids sort by creation time, then by the in-millisecond counter. */
export function compareBatchIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function batchCreatedMs(batchId: string): number {
  return Number.parseInt(batchId.slice(0, 8) + batchId.slice(9, 13), 16)
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

/** POSIX rename is atomic: exactly one competitor wins, every other one gets ENOENT. */
function tryRename(dir: string, from: string, to: string): boolean {
  try {
    renameSync(join(dir, from), join(dir, to))
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

export function listSpool(dir: string): SpoolEntry[] {
  try {
    return readdirSync(dir).map(parseSpoolName)
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

/**
 * The claim rename runs off the event loop: a rename can stall for a long time on a contended
 * filesystem, and a stalled synchronous call would hold every timer, the shutdown deadline included.
 */
export async function claimBatch(
  ctx: SpoolContext,
  entry: { readonly signal: Signal; readonly batchId: string },
): Promise<string | null> {
  const claimed = sendingName(entry.signal, entry.batchId, ctx.bootId, ctx.nowMs() + CLAIM_LEASE_MS)
  try {
    await rename(join(ctx.dir, batchName(entry.signal, entry.batchId)), join(ctx.dir, claimed))
    return claimed
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

export function renewClaim(ctx: SpoolContext, claimed: string): string | null {
  const entry = parseSpoolName(claimed)
  if (entry.kind !== "sending") return null
  const renewed = sendingName(entry.signal, entry.batchId, ctx.bootId, ctx.nowMs() + CLAIM_LEASE_MS)
  return tryRename(ctx.dir, claimed, renewed) ? renewed : null
}

/** Only the claim's owner releases it, so the owner-only link move is enough (no competitor). */
export function releaseClaim(ctx: SpoolContext, claimed: string): boolean {
  const entry = parseSpoolName(claimed)
  return entry.kind === "sending" && tryLinkMove(ctx.dir, claimed, batchName(entry.signal, entry.batchId))
}

export function deleteFile(dir: string, name: string): boolean {
  try {
    unlinkSync(join(dir, name))
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"])

function lacksHardLinks(error: unknown): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string" && NO_HARD_LINKS.has(error.code)
}

/**
 * Moves a file that only this process may move (its own active file or its own claim) as a hard
 * link plus an unlink of the old name: a reader still sees the new name appear with the complete
 * content, and the pair costs well under a millisecond where a rename can take 50-130 ms (measured
 * in a Linux container VM). A crash between the two leaves the old name as a second link, which the
 * sweep deletes instead of recovering it again. Filesystems without hard links fall back to rename.
 * Competing movers (claims, lease reclaims) keep using rename, whose atomicity picks one winner.
 */
function tryLinkMove(dir: string, from: string, to: string): boolean {
  try {
    linkSync(join(dir, from), join(dir, to))
  } catch (error) {
    if (isMissing(error)) return false
    if (!lacksHardLinks(error)) throw error
    return tryRename(dir, from, to)
  }
  deleteFile(dir, from)
  return true
}

export function publishBatch(dir: string, activeName: string, sealedName: string): void {
  if (!tryLinkMove(dir, activeName, sealedName)) throw new Error(`active spool file vanished before its seal`)
}

export function dropFile(ctx: SpoolContext, name: string, reason: DropReason): void {
  const records = countSpoolRecords(join(ctx.dir, name))
  if (deleteFile(ctx.dir, name)) ctx.onDrop(reason, records)
}

export function quarantineFile(ctx: SpoolContext, name: string): void {
  const records = countSpoolRecords(join(ctx.dir, name))
  mkdirSync(join(ctx.dir, "quarantine"), { recursive: true, mode: 0o700 })
  if (tryRename(ctx.dir, name, join("quarantine", name))) ctx.onDrop("corrupt", records)
}

type FileStat = { readonly size: number; readonly mtimeMs: number; readonly birthMs: number; readonly links: number }

export function fileStat(dir: string, name: string): FileStat | null {
  try {
    const stat = statSync(join(dir, name))
    const birthMs = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs
    return { size: stat.size, mtimeMs: stat.mtimeMs, birthMs, links: stat.nlink }
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

function isDeadOwner(ctx: SpoolContext, entry: { readonly pid: number; readonly bootId: string }): boolean {
  if (entry.pid === ctx.pid) return entry.bootId !== ctx.bootId
  return !ctx.isPidAlive(entry.pid)
}

/**
 * Recovers what dead or stalled processes left (D-H claim rules): expired leases go back to sealed
 * batches, a dead owner's idle active file is sealed (its batch id keeps the file's creation time,
 * so the 14-day limit is never extended), an active file or expired claim that is still a second
 * link of its already moved file (a crash inside `tryLinkMove`) is deleted, and sealed batches past
 * the age limit are dropped.
 */
export function sweepSpool(ctx: SpoolContext): void {
  const now = ctx.nowMs()
  for (const entry of listSpool(ctx.dir)) {
    if (entry.kind === "sending" && entry.leaseExpiresMs <= now) {
      if ((fileStat(ctx.dir, entry.name)?.links ?? 1) > 1) deleteFile(ctx.dir, entry.name)
      else tryRename(ctx.dir, entry.name, batchName(entry.signal, entry.batchId))
    } else if (entry.kind === "active" && isDeadOwner(ctx, entry)) {
      const stat = fileStat(ctx.dir, entry.name)
      if (stat !== null && stat.links > 1) {
        deleteFile(ctx.dir, entry.name)
      } else if (stat !== null && now - stat.mtimeMs >= DEAD_OWNER_IDLE_MS) {
        tryRename(ctx.dir, entry.name, batchName(entry.signal, createBatchId(stat.birthMs)))
      }
    }
  }
  for (const entry of listSpool(ctx.dir)) {
    if (entry.kind === "batch" && now - batchCreatedMs(entry.batchId) > ctx.maxAgeMs) {
      dropFile(ctx, entry.name, "expired")
    }
  }
}

export function oldestSealedBatches(dir: string): Extract<SpoolEntry, { readonly kind: "batch" }>[] {
  return listSpool(dir)
    .flatMap((entry) => (entry.kind === "batch" ? [entry] : []))
    .sort((a, b) => compareBatchIds(a.batchId, b.batchId))
}
