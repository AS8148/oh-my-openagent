import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs"
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

export function releaseClaim(ctx: SpoolContext, claimed: string): boolean {
  const entry = parseSpoolName(claimed)
  return entry.kind === "sending" && tryRename(ctx.dir, claimed, batchName(entry.signal, entry.batchId))
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

export function dropFile(ctx: SpoolContext, name: string, reason: DropReason): void {
  const records = countSpoolRecords(join(ctx.dir, name))
  if (deleteFile(ctx.dir, name)) ctx.onDrop(reason, records)
}

export function quarantineFile(ctx: SpoolContext, name: string): void {
  const records = countSpoolRecords(join(ctx.dir, name))
  mkdirSync(join(ctx.dir, "quarantine"), { recursive: true, mode: 0o700 })
  if (tryRename(ctx.dir, name, join("quarantine", name))) ctx.onDrop("corrupt", records)
}

function fileStat(dir: string, name: string): { readonly size: number; readonly mtimeMs: number; readonly birthMs: number } | null {
  try {
    const stat = statSync(join(dir, name))
    return { size: stat.size, mtimeMs: stat.mtimeMs, birthMs: stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs }
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
 * so the 14-day limit is never extended), and sealed batches past the age limit are dropped.
 */
export function sweepSpool(ctx: SpoolContext): void {
  const now = ctx.nowMs()
  for (const entry of listSpool(ctx.dir)) {
    if (entry.kind === "sending" && entry.leaseExpiresMs <= now) {
      tryRename(ctx.dir, entry.name, batchName(entry.signal, entry.batchId))
    } else if (entry.kind === "active" && isDeadOwner(ctx, entry)) {
      const stat = fileStat(ctx.dir, entry.name)
      if (stat !== null && now - stat.mtimeMs >= DEAD_OWNER_IDLE_MS) {
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

/** Oldest sealed batches go first; active files and in-flight claims are never evicted. */
export function enforceSpoolCap(ctx: SpoolContext): void {
  const entries = listSpool(ctx.dir)
  let total = 0
  const sealed: { readonly name: string; readonly batchId: string; readonly size: number }[] = []
  for (const entry of entries) {
    const stat = fileStat(ctx.dir, entry.name)
    if (stat === null) continue
    total += stat.size
    if (entry.kind === "batch") sealed.push({ name: entry.name, batchId: entry.batchId, size: stat.size })
  }
  sealed.sort((a, b) => batchCreatedMs(a.batchId) - batchCreatedMs(b.batchId) || a.batchId.localeCompare(b.batchId))
  for (const file of sealed) {
    if (total <= ctx.capBytes) return
    dropFile(ctx, file.name, "evicted")
    total -= file.size
  }
}

export function oldestSealedBatches(dir: string): Extract<SpoolEntry, { readonly kind: "batch" }>[] {
  return listSpool(dir)
    .flatMap((entry) => (entry.kind === "batch" ? [entry] : []))
    .sort((a, b) => batchCreatedMs(a.batchId) - batchCreatedMs(b.batchId) || a.batchId.localeCompare(b.batchId))
}
