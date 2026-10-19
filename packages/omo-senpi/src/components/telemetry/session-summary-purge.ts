import { readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs"
import { join } from "node:path"

// The opted-out side of session_summary, kept in the entry bundle with node:fs only: turning telemetry off
// must delete what earlier runs queued without loading any telemetry code (the recorder lives in a sidecar).

type QueuedScope = { readonly cwd?: string }

/** `<state>/session-summary`: windows at the top, events awaiting delivery under `pending/`. */
export function summaryDir(stateDir: string): string {
  return join(stateDir, "session-summary")
}

/** True when `<state>/session-summary` holds any entry. */
export function hasQueuedSummaryFiles(stateDir: string): boolean {
  return names(summaryDir(stateDir)).length > 0
}

/**
 * Deletes every queued window and pending event that may never be sent: no `enabled` consent mark, or a scope
 * whose consent, read now, is off. It only reads and deletes, never writes. `all` (a machine-wide opt-out)
 * deletes the whole directory, whatever each record says.
 */
export function purgeUnconsentedQueue(stateDir: string, isScopeConsented: (scope: QueuedScope) => boolean, all = false): void {
  const dir = summaryDir(stateDir)
  if (all) {
    rmSync(dir, { recursive: true, force: true })
    return
  }
  for (const folder of [dir, join(dir, "pending")]) {
    for (const name of names(folder)) {
      if (!name.endsWith(".json")) continue
      const path = join(folder, name)
      const verdict = sendable(read(path), isScopeConsented)
      if (verdict === false) remove(path)
    }
  }
}

// A record parses to its consent mark and scope; an unreadable file is left for the recorder's own sweep.
function sendable(value: unknown, isScopeConsented: (scope: QueuedScope) => boolean): boolean | undefined {
  if (typeof value !== "object" || value === null || Reflect.get(value, "v") !== 2) return undefined
  if (Reflect.get(value, "consent") !== "enabled") return false
  const scope: unknown = Reflect.get(value, "scope")
  if (typeof scope !== "object" || scope === null || Array.isArray(scope)) return false
  const cwd: unknown = Reflect.get(scope, "cwd")
  if (cwd !== undefined && typeof cwd !== "string") return false
  return isScopeConsented(cwd === undefined ? {} : { cwd })
}

function names(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function read(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

function remove(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Already gone, or claimed by another process: nothing of it is sent either way.
  }
}
