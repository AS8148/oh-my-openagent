import { linkSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs"
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

/** UUIDv7 (RFC 9562): 48-bit unix milliseconds, version 7, variant 10, random tail. Never sent. */
export function createBatchId(unixMs: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let timestamp = Math.max(0, Math.floor(unixMs))
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp % 256
    timestamp = Math.floor(timestamp / 256)
  }
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f)
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f)
  const hex = Array.from(bytes, (byte) => HEX[byte] ?? "00").join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
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

export function claimBatch(ctx: SpoolContext, entry: { readonly signal: Signal; readonly batchId: string }): string | null {
  const claimed = sendingName(entry.signal, entry.batchId, ctx.bootId, ctx.nowMs() + CLAIM_LEASE_MS)
  return tryRename(ctx.dir, batchName(entry.signal, entry.batchId), claimed) ? claimed : null
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

function fileStat(dir: string, name: string): FileStat | null {
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

/**
 * Sizes of sealed batch files keyed by `<signal>-<batchId>`. A sealed batch is never written again
 * (claims only rename it), so its size is stat'ed once per process instead of on every cap check.
 */
type SpoolSizeCache = Map<string, number>

const sizeKey = (signal: Signal, batchId: string): string => `${signal}-${batchId}`

/**
 * Oldest sealed batches go first; active files and in-flight claims are never evicted. Returns the
 * directory's total size after eviction.
 */
export function enforceSpoolCap(ctx: SpoolContext, sizes: SpoolSizeCache = new Map()): number {
  const entries = listSpool(ctx.dir)
  let total = 0
  const sealed: { readonly name: string; readonly batchId: string; readonly size: number }[] = []
  const present = new Set<string>()
  for (const entry of entries) {
    const key = entry.kind === "batch" || entry.kind === "sending" ? sizeKey(entry.signal, entry.batchId) : undefined
    let size = key === undefined ? undefined : sizes.get(key)
    if (size === undefined) {
      const stat = fileStat(ctx.dir, entry.name)
      if (stat === null) continue
      size = stat.size
      if (key !== undefined) sizes.set(key, size)
    }
    if (key !== undefined) present.add(key)
    total += size
    if (entry.kind === "batch") sealed.push({ name: entry.name, batchId: entry.batchId, size })
  }
  for (const key of sizes.keys()) if (!present.has(key)) sizes.delete(key)
  sealed.sort((a, b) => batchCreatedMs(a.batchId) - batchCreatedMs(b.batchId) || a.batchId.localeCompare(b.batchId))
  for (const file of sealed) {
    if (total <= ctx.capBytes) break
    dropFile(ctx, file.name, "evicted")
    total -= file.size
  }
  return total
}

/**
 * Enforces the cap after each of this process's seals without listing the directory every time:
 * the last scan's total plus the bytes sealed since is an upper bound for everything this process
 * added (sends only shrink the spool), so the directory is scanned only once that bound passes the
 * cap. Other writers enforce the cap on their own seals.
 */
export class SpoolCap {
  readonly #ctx: SpoolContext
  readonly #sizes: SpoolSizeCache = new Map()
  #bound: number | null = null

  constructor(ctx: SpoolContext) {
    this.#ctx = ctx
  }

  sealed(signal: Signal, batchId: string, bytes: number): void {
    this.#sizes.set(sizeKey(signal, batchId), bytes)
    if (this.#bound !== null && this.#bound + bytes <= this.#ctx.capBytes) {
      this.#bound += bytes
      return
    }
    this.#bound = null
    this.#bound = enforceSpoolCap(this.#ctx, this.#sizes)
  }
}

export function oldestSealedBatches(dir: string): Extract<SpoolEntry, { readonly kind: "batch" }>[] {
  return listSpool(dir)
    .flatMap((entry) => (entry.kind === "batch" ? [entry] : []))
    .sort((a, b) => batchCreatedMs(a.batchId) - batchCreatedMs(b.batchId) || a.batchId.localeCompare(b.batchId))
}
