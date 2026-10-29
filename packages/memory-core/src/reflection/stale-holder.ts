// Who holds the reflection lock, decided fail-closed (#10377). This is the one decision behind the
// session's stale-lock recovery and the `omo doctor` report: the CLI runs a generated bundle of this
// file (script/build-reflection-lock.ts, checked for staleness by its test), so the two cannot drift.
//
// Dead means all of: the launcher on this host is gone (or its pid now belongs to another process),
// the publish claimant, if any, is gone, and the run recorded a valid outcome. Anything that cannot be
// proven is "stuck", never "dead". Each rule carries a `rule:` tag named by its test.

import { execFile } from "node:child_process"
import { hostname as readHostname } from "node:os"
import { join } from "node:path"

import { readFile } from "../fs/resilient"
import { getPidLiveness, getProcessStartIdentity, startIdentitiesComparable, type ProcessLiveness } from "../locks/process-identity"

export type ReflectionLockVerdict =
  | { readonly state: "none" }
  | { readonly state: "live"; readonly runId: string }
  | { readonly state: "dead"; readonly runId: string }
  | { readonly state: "stuck"; readonly runId: string; readonly reason: string }

export interface ReflectionLockProbe {
  readonly readText?: (path: string) => Promise<string>
  readonly hostname?: () => string
  readonly hostId?: () => string | null | Promise<string | null>
  readonly isLocalHost?: (
    recorded: { readonly hostname: string; readonly hostId?: string },
    current: { readonly hostname: string; readonly hostId?: string | null },
  ) => boolean
  readonly getPidLiveness?: (pid: number) => ProcessLiveness
  readonly getProcessStartIdentity?: (pid: number) => Promise<string | null>
}

type JsonRead =
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly code: string }
  | { readonly kind: "invalid" }
  | { readonly kind: "ok"; readonly value: unknown }

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "unknown error"
}

async function readJson(path: string, readText: (path: string) => Promise<string>): Promise<JsonRead> {
  let text: string
  try {
    text = await readText(path)
  } catch (error) {
    const code = errorCode(error)
    return code === "ENOENT" ? { kind: "missing" } : { kind: "unreadable", code }
  }
  try {
    return { kind: "ok", value: JSON.parse(text) as unknown }
  } catch {
    return { kind: "invalid" }
  }
}

function fieldsOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
}

// The shape reconciliation reads as a RunOutcome (omo-senpi worker/run-artifacts.ts). A file that does
// not match it, or names another run, is not a recorded outcome, so nothing is finalized on it.
function isRunOutcome(value: unknown, runId: string): boolean {
  const fields = fieldsOf(value)
  const childExit = fieldsOf(fields.childExit)
  return fields.version === 1
    && fields.runId === runId
    && typeof fields.finishedAt === "string"
    && (fields.attempt === undefined || (typeof fields.attempt === "number" && Number.isInteger(fields.attempt) && fields.attempt > 0))
    && typeof fields.childExit === "object" && fields.childExit !== null
    && (childExit.code === null || typeof childExit.code === "number")
    && (childExit.signal === null || typeof childExit.signal === "string")
    && typeof fields.timedOut === "boolean"
}

let cachedLocalHostId: Promise<string | null> | undefined

/**
 * Reads the Bonjour local host name, which macOS keeps across DHCP leases while
 * `os.hostname()` follows the network's reverse-DNS name.
 */
async function readDarwinLocalHostName(): Promise<string | null> {
  return await new Promise((resolve) => {
    // `scutil` answers in milliseconds, but the spawn must never hold the event loop: every
    // session turn and `/doctor` call reaches this path.
    execFile("scutil", ["--get", "LocalHostName"], { encoding: "utf8", timeout: 500, windowsHide: true }, (error, stdout) => {
      if (error !== null) {
        resolve(null)
        return
      }
      const value = stdout.trim()
      resolve(value.length > 0 ? value : null)
    })
  })
}

/**
 * Stable per-machine identity, resolved once per process (single flight, so concurrent callers
 * share one spawn). Non-macOS platforms report `null` and fall back to the hostname rule.
 */
export function getStableLocalHostId(): Promise<string | null> {
  cachedLocalHostId ??= process.platform === "darwin" ? readDarwinLocalHostName() : Promise.resolve(null)
  return cachedLocalHostId
}

/**
 * Decides whether a lock's recorded launcher is this machine.
 *
 * A record carrying a host id matches only that exact id, so two machines that happen to share a
 * hostname (or two Macs behind one DHCP server) stay distinct while a single machine that was
 * renamed by DHCP still matches. Legacy records carry no id and keep the exact hostname rule.
 */
export function isLocalHost(
  recorded: { readonly hostname: string; readonly hostId?: string },
  current: { readonly hostname: string; readonly hostId?: string | null },
): boolean {
  if (typeof recorded.hostId === "string" && recorded.hostId.length > 0) {
    return current.hostId !== undefined && current.hostId !== null && recorded.hostId === current.hostId
  }
  return recorded.hostname === current.hostname
}

function stuck(runId: string, reason: string): ReflectionLockVerdict {
  return { state: "stuck", runId, reason }
}

// A live pid still counts as gone when its recorded start identity proves the pid was reused: the rule
// reconciliation applies (worker/run-liveness.ts). An unreadable or incomparable start keeps it live.
async function launcherLiveness(pid: number, recordedStart: unknown, probe: ReflectionLockProbe): Promise<ProcessLiveness> {
  const liveness = (probe.getPidLiveness ?? getPidLiveness)(pid)
  if (liveness !== "alive" || typeof recordedStart !== "string") return liveness
  const actualStart = await (probe.getProcessStartIdentity ?? getProcessStartIdentity)(pid).catch(() => null)
  if (actualStart !== null && startIdentitiesComparable(recordedStart, actualStart) && recordedStart !== actualStart) return "dead" // rule:pid-reused
  return "alive"
}

export async function classifyReflectionLockHolder(
  reflectionDir: string,
  probe: ReflectionLockProbe = {},
): Promise<ReflectionLockVerdict> {
  const readText = probe.readText ?? ((path: string) => readFile(path, "utf8"))
  const active = await readJson(join(reflectionDir, "active.lock"), readText)
  if (active.kind === "missing") return { state: "none" }
  if (active.kind === "unreadable") return stuck("unknown", `active.lock could not be read (${active.code})`) // rule:lock-unreadable
  if (active.kind === "invalid") return stuck("unknown", "active.lock is not valid JSON") // rule:lock-invalid
  const fields = fieldsOf(active.value)
  const runId = typeof fields.runId === "string" ? fields.runId : "unknown"
  const launcherPid = typeof fields.launcherPid === "number" ? fields.launcherPid : undefined
  const launcherHostname = typeof fields.launcherHostname === "string" ? fields.launcherHostname : undefined
  const launcherHostId = typeof fields.launcherHostId === "string" ? fields.launcherHostId : undefined
  if (launcherPid === undefined || launcherHostname === undefined) return stuck(runId, "its launcher identity is missing") // rule:launcher-identity

  const currentHost = {
    hostname: (probe.hostname ?? readHostname)(),
    hostId: await (probe.hostId ?? getStableLocalHostId)(),
  }
  const localCheck = probe.isLocalHost ?? isLocalHost
  if (!localCheck({ hostname: launcherHostname, hostId: launcherHostId }, currentHost)) {
    return stuck(runId, `it is owned by host ${launcherHostname}, which cannot be checked from here`) // rule:other-host
  }
  const launcher = await launcherLiveness(launcherPid, fields.launcherProcessStart, probe)
  if (launcher === "alive") return { state: "live", runId } // rule:launcher-alive
  if (launcher === "unknown") return stuck(runId, `launcher pid ${launcherPid} could not be checked`) // rule:launcher-unknown
  const runDir = join(reflectionDir, "runs", runId)
  const outcome = await readJson(join(runDir, "outcome.json"), readText)
  if (outcome.kind === "missing") return stuck(runId, `launcher pid ${launcherPid} is gone and the run recorded no outcome`) // rule:outcome-missing
  if (outcome.kind === "unreadable") return stuck(runId, `its outcome could not be read (${outcome.code})`) // rule:outcome-unreadable
  if (outcome.kind === "invalid") return stuck(runId, "its outcome is not valid JSON") // rule:outcome-invalid
  if (!isRunOutcome(outcome.value, runId)) return stuck(runId, "its outcome is not a recorded run outcome") // rule:outcome-schema
  const claim = await readJson(join(runDir, "terminal-claim.json"), readText)
  if (claim.kind === "unreadable") return stuck(runId, `its terminal claim could not be read (${claim.code})`) // rule:claim-unreadable
  if (claim.kind === "invalid") return stuck(runId, "its terminal claim is not valid JSON") // rule:claim-invalid
  if (claim.kind === "ok") {
    const claimantPid = fieldsOf(claim.value).claimantPid
    if (typeof claimantPid !== "number") return stuck(runId, "its terminal claim names no claimant") // rule:claim-no-claimant
    const claimant = (probe.getPidLiveness ?? getPidLiveness)(claimantPid)
    if (claimant === "alive") return { state: "live", runId } // rule:claimant-alive
    if (claimant === "unknown") return stuck(runId, `publish claimant pid ${claimantPid} could not be checked`) // rule:claimant-unknown
  }
  return { state: "dead", runId }
}
