// omo doctor: a reflection lock held by a run that cannot finish (#10377). Mirrors omo-senpi's
// reflection-stale-active.ts, which the CLI cannot import. Fail-closed: a holder is "dead" only when its
// launcher on this host is gone, its publish claimant (if any) is gone, and the run recorded its outcome.
// Anything that cannot be proven is "stuck". Both are reported with the next step, so a stopped
// reflection is never silent; a live holder or no lock prints nothing.

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { homedir, hostname as readHostname } from "node:os"
import { basename, join, resolve } from "node:path"

const MEMORY_ROOT_ENV_VAR = "OMO_MEMORY_HOME"

function memoryRoot(env) {
  const override = env[MEMORY_ROOT_ENV_VAR]
  if (override === undefined || override.trim() === "") return join(homedir(), ".omo", "memory")
  return resolve(process.cwd(), override)
}

export function pidLiveness(pid) {
  try {
    process.kill(pid, 0)
    return "alive"
  } catch (error) {
    if (error?.code === "ESRCH") return "dead"
    if (error?.code === "EPERM") return "alive"
    return "unknown"
  }
}

function readJson(path, io) {
  if (!io.exists(path)) return { state: "missing" }
  try {
    return { state: "ok", value: JSON.parse(io.readText(path)) }
  } catch {
    return { state: "invalid" }
  }
}

const fileIo = { exists: existsSync, readText: (path) => readFileSync(path, "utf8") }

export function classifyReflectionLock(reflectionDir, seams = {}) {
  const io = seams.io ?? fileIo
  const liveness = seams.liveness ?? pidLiveness
  const here = (seams.hostname ?? readHostname)()
  const active = readJson(join(reflectionDir, "active.lock"), io)
  if (active.state === "missing") return { state: "none" }
  const record = active.state === "ok" && typeof active.value === "object" && active.value !== null ? active.value : {}
  const runId = typeof record.runId === "string" ? record.runId : "unknown"
  if (active.state === "invalid") return { state: "stuck", runId, reason: "active.lock is not valid JSON" }
  const launcherPid = typeof record.launcherPid === "number" ? record.launcherPid : undefined
  const launcherHostname = typeof record.launcherHostname === "string" ? record.launcherHostname : undefined
  if (launcherPid === undefined || launcherHostname === undefined) {
    return { state: "stuck", runId, reason: "its launcher identity is missing" }
  }
  if (launcherHostname !== here) {
    return { state: "stuck", runId, reason: `it is owned by host ${launcherHostname}, which cannot be checked from here` }
  }
  const launcher = liveness(launcherPid)
  if (launcher === "alive") return { state: "live", runId }
  if (launcher === "unknown") return { state: "stuck", runId, reason: `launcher pid ${launcherPid} could not be checked` }
  const runDir = join(reflectionDir, "runs", runId)
  if (!io.exists(join(runDir, "outcome.json"))) {
    return { state: "stuck", runId, reason: `launcher pid ${launcherPid} is gone and the run recorded no outcome` }
  }
  const claim = readJson(join(runDir, "terminal-claim.json"), io)
  if (claim.state === "invalid") return { state: "stuck", runId, reason: "its terminal claim is not valid JSON" }
  if (claim.state === "ok") {
    const claimantPid = claim.value?.claimantPid
    if (typeof claimantPid !== "number") return { state: "stuck", runId, reason: "its terminal claim names no claimant" }
    const claimant = liveness(claimantPid)
    if (claimant === "alive") return { state: "live", runId }
    if (claimant === "unknown") return { state: "stuck", runId, reason: `publish claimant pid ${claimantPid} could not be checked` }
  }
  return { state: "dead", runId }
}

export function formatReflectionLockLines(identity, verdict, reflectionDir) {
  if (verdict.state === "none" || verdict.state === "live") return []
  const lock = join(reflectionDir, "active.lock")
  if (verdict.state === "dead") {
    return [`WARN memory reflection is stuck on a stale lock (${identity}): run ${verdict.runId} still holds ${lock}, but its launcher is gone and it already recorded its outcome. Next step: open a session and send /reflect (or any message); the session settles that run and starts any queued request.`]
  }
  return [`WARN memory reflection is stuck on a stale lock (${identity}): run ${verdict.runId} still holds ${lock} and ${verdict.reason}. Next step: run /doctor in a session; if no reflection run is active, move ${lock} aside (keep a backup) and start a new session.`]
}

function listDurableIdentities(agentsRoot) {
  try {
    return readdirSync(agentsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => join(agentsRoot, entry.name))
      .filter((identityRoot) => existsSync(join(identityRoot, "repo")))
  } catch {
    return []
  }
}

export function reflectionLockReport(options = {}) {
  const agentsRoot = join(memoryRoot(options.env ?? process.env), "agents")
  const lines = []
  for (const identityRoot of options.listIdentities?.(agentsRoot) ?? listDurableIdentities(agentsRoot)) {
    const reflectionDir = join(identityRoot, "runtime", "reflection")
    const verdict = classifyReflectionLock(reflectionDir, options.reflectionLockSeams ?? {})
    lines.push(...formatReflectionLockLines(basename(identityRoot), verdict, reflectionDir))
  }
  return lines
}
