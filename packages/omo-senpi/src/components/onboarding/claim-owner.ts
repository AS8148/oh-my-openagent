import { randomUUID } from "node:crypto"
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import {
  getPidLiveness,
  getProcessStartIdentity,
  startIdentitiesConflict,
  type ProcessLiveness,
} from "@oh-my-opencode/memory-core/process-identity"

import { isOnboardingCompletionRecorded, ONBOARDING_MARKER, readOnboardingCompletedAt } from "./state"

// A claim written before claims recorded their owner cannot be probed; past this age it is abandoned.
export const OWNERLESS_CLAIM_STALE_MS = 24 * 3_600_000

export interface ClaimOwnerSeams {
  readonly pid?: number
  readonly getPidLiveness?: (pid: number) => ProcessLiveness
  readonly getProcessStartIdentity?: (pid: number) => Promise<string | null>
  readonly now?: () => number
}

interface ClaimOwner {
  readonly pid: number
  readonly processStart: string | null
}

export interface OnboardingStateSnapshot {
  /** ISO time onboarding finished; null while it has not. */
  readonly completedAt: string | null
  /** A claim is held by a running owner and onboarding has not finished. */
  readonly inProgress: boolean
}

export async function readOnboardingState(stateDir: string, seams: ClaimOwnerSeams = {}): Promise<OnboardingStateSnapshot> {
  const completedAt = readOnboardingCompletedAt(stateDir)
  if (completedAt !== null) return { completedAt, inProgress: false }
  const held = readRaw(join(stateDir, ONBOARDING_MARKER))
  return { completedAt: null, inProgress: held !== null && await claimHolderLive(held, seams) }
}

/**
 * Takes the install-wide claim, recording its owner (pid + process start identity). A held claim
 * whose owner is gone (exited, or its pid reused) is taken over; a live or unprovable owner blocks.
 */
export async function claimOnboardingOwned(stateDir: string, seams: ClaimOwnerSeams = {}): Promise<boolean> {
  try {
    mkdirSync(stateDir, { recursive: true })
    if (isOnboardingCompletionRecorded(stateDir)) return false
    const marker = join(stateDir, ONBOARDING_MARKER)
    const pid = seams.pid ?? process.pid
    const processStart = await (seams.getProcessStartIdentity ?? getProcessStartIdentity)(pid).catch(() => null)
    const now = seams.now ?? Date.now
    const record = { claimedAt: new Date(now()).toISOString(), version: 2, owner: { pid, processStart }, nonce: randomUUID() }
    if (writeClaim(marker, record)) return true
    const held = readRaw(marker)
    if (held === null) return writeClaim(marker, record)
    if (await claimHolderLive(held, seams)) return false
    if (!takeOverClaim(marker, held)) return false
    if (isOnboardingCompletionRecorded(stateDir)) return false
    return writeClaim(marker, record)
  } catch {
    return false
  }
}

function writeClaim(marker: string, record: Record<string, unknown>): boolean {
  try {
    writeFileSync(marker, JSON.stringify(record), { flag: "wx", mode: 0o600 })
    return true
  } catch {
    return false
  }
}

// Moves the judged-dead claim aside atomically. Only one contender's rename can move a given file;
// if the file it moved is no longer the claim it judged (a fresh claim landed meanwhile), it is put
// back and the takeover yields.
function takeOverClaim(marker: string, judged: string): boolean {
  const aside = `${marker}.stale.${process.pid}.${randomUUID()}`
  try {
    renameSync(marker, aside)
  } catch {
    return false
  }
  const moved = readRaw(aside)
  if (moved !== judged) {
    try { linkSync(aside, marker) } catch { /* a newer claim already holds the marker */ }
  }
  try { unlinkSync(aside) } catch { /* already gone */ }
  return moved === judged
}

function readRaw(path: string): string | null {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

// Unparseable content or a marker without `claimedAt` is a pre-split marker, which means completed
// (state.ts `readLegacyCompletion`), so it is never taken over.
async function claimHolderLive(raw: string, seams: ClaimOwnerSeams): Promise<boolean> {
  let record: unknown
  try {
    record = JSON.parse(raw)
  } catch {
    return true
  }
  if (!isRecord(record) || typeof record["claimedAt"] !== "string") return true
  const owner = record["owner"]
  if (isRecord(owner) && typeof owner["pid"] === "number" && Number.isInteger(owner["pid"]) && owner["pid"] > 0) {
    const processStart = typeof owner["processStart"] === "string" ? owner["processStart"] : null
    // An owner that cannot be probed keeps its claim, as every claim did before owners were recorded.
    return await ownerAlive({ pid: owner["pid"], processStart }, seams).catch(() => true)
  }
  const claimedAt = Date.parse(record["claimedAt"])
  return Number.isNaN(claimedAt) || (seams.now ?? Date.now)() - claimedAt < OWNERLESS_CLAIM_STALE_MS
}

/**
 * An owner is gone when its pid no longer runs, or runs with a start identity that provably belongs
 * to another process (pid reuse). Anything unprovable keeps the owner alive, so a live claim is never
 * stolen; identities from different readers are never compared (`startIdentitiesConflict`).
 */
async function ownerAlive(owner: ClaimOwner, seams: ClaimOwnerSeams): Promise<boolean> {
  const state = (seams.getPidLiveness ?? getPidLiveness)(owner.pid)
  if (state === "dead") return false
  if (state === "unknown" || owner.processStart === null) return true
  const actual = await (seams.getProcessStartIdentity ?? getProcessStartIdentity)(owner.pid)
  return actual === null || !startIdentitiesConflict(owner.processStart, actual)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
