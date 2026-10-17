// Recovery of a reflection reservation whose holder died after this session already reconciled (#10377).
//
// Session-start reconciliation runs once per session (wiring.ts onSettled), so a host that dies
// mid-publish later leaves runtime/reflection/active.lock held, and every later request only
// queues behind it. This module decides, fail-closed, whether that holder is provably gone; only
// then is the existing reconciliation asked to settle the run. Reconciliation stays the only code
// that settles a run. When liveness cannot be proven either way, nothing is reclaimed and the
// stuck state is reported with the next step instead, so the stop is never silent.

import { existsSync, readFile } from "@oh-my-opencode/memory-core/fs"
import { getPidLiveness, type ProcessLiveness } from "@oh-my-opencode/memory-core"
import { hostname as readHostname } from "node:os"
import { join } from "node:path"

export type ActiveHolderVerdict =
  | { readonly state: "none" }
  | { readonly state: "live"; readonly runId: string }
  | { readonly state: "dead"; readonly runId: string }
  | { readonly state: "stuck"; readonly runId: string; readonly reason: string }

export interface ActiveHolderSeams {
  readonly getPidLiveness?: (pid: number) => ProcessLiveness
  readonly hostname?: () => string
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  }
}

/**
 * Dead means all of: the launcher on this host is gone, the publish claimant (if any) is gone, and
 * the run recorded its outcome. Anything that cannot be proven is `stuck`, never `dead`.
 */
export async function classifyActiveReflectionHolder(
  reflectionDir: string,
  seams: ActiveHolderSeams = {},
): Promise<ActiveHolderVerdict> {
  const active = await readJson(join(reflectionDir, "active.lock"))
  if (active === null) return { state: "none" }
  const fields = record(active)
  const runId = typeof fields.runId === "string" ? fields.runId : "unknown"
  if (active === undefined) return { state: "stuck", runId, reason: "active.lock is not valid JSON" }
  const launcherPid = typeof fields.launcherPid === "number" ? fields.launcherPid : undefined
  const launcherHostname = typeof fields.launcherHostname === "string" ? fields.launcherHostname : undefined
  if (launcherPid === undefined || launcherHostname === undefined) {
    return { state: "stuck", runId, reason: "its launcher identity is missing" }
  }
  const here = (seams.hostname ?? readHostname)()
  if (launcherHostname !== here) {
    return { state: "stuck", runId, reason: `it is owned by host ${launcherHostname}, which cannot be checked from here` }
  }
  const liveness = seams.getPidLiveness ?? getPidLiveness
  const launcher = liveness(launcherPid)
  if (launcher === "alive") return { state: "live", runId }
  if (launcher === "unknown") return { state: "stuck", runId, reason: `launcher pid ${launcherPid} could not be checked` }
  const runDir = join(reflectionDir, "runs", runId)
  if (!existsSync(join(runDir, "outcome.json"))) {
    return { state: "stuck", runId, reason: `launcher pid ${launcherPid} is gone and the run recorded no outcome` }
  }
  const claim = await readJson(join(runDir, "terminal-claim.json"))
  if (claim === undefined) return { state: "stuck", runId, reason: "its terminal claim is not valid JSON" }
  if (claim !== null) {
    const claimantPid = record(claim).claimantPid
    if (typeof claimantPid !== "number") return { state: "stuck", runId, reason: "its terminal claim names no claimant" }
    const claimant = liveness(claimantPid)
    if (claimant === "alive") return { state: "live", runId }
    if (claimant === "unknown") return { state: "stuck", runId, reason: `publish claimant pid ${claimantPid} could not be checked` }
  }
  return { state: "dead", runId }
}

export function staleReflectionLockNotice(reflectionDir: string, verdict: { readonly runId: string; readonly reason: string }): string {
  return `memory reflection is stuck on a stale lock: run ${verdict.runId} still holds it and ${verdict.reason}, so new reflection requests only queue. Next step: run /doctor; if no reflection run is active, move ${join(reflectionDir, "active.lock")} aside (keep a backup) and start a new session.`
}

/**
 * Settles a provably dead holder through reconciliation; reports any other non-live holder.
 * Returns the notice text when the stuck state must be shown, otherwise undefined.
 */
export async function recoverStaleReflectionHolder(input: {
  readonly reflectionDir: string
  readonly reconcile: () => Promise<void>
  readonly seams?: ActiveHolderSeams
}): Promise<{ readonly verdict: ActiveHolderVerdict; readonly notice?: string }> {
  const verdict = await classifyActiveReflectionHolder(input.reflectionDir, input.seams)
  if (verdict.state === "dead") {
    await input.reconcile()
    const after = await classifyActiveReflectionHolder(input.reflectionDir, input.seams)
    if (after.state === "stuck") return { verdict: after, notice: staleReflectionLockNotice(input.reflectionDir, after) }
    if (after.state === "dead" && after.runId === verdict.runId) {
      return {
        verdict: after,
        notice: staleReflectionLockNotice(input.reflectionDir, { runId: after.runId, reason: "recovering it did not release the lock" }),
      }
    }
    return { verdict }
  }
  if (verdict.state === "stuck") return { verdict, notice: staleReflectionLockNotice(input.reflectionDir, verdict) }
  return { verdict }
}
