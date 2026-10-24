import { lstatSync, readdirSync, rmdirSync, unlinkSync, type Dirent } from "node:fs"
import { join } from "node:path"
import type { TelemetryDiagnosticInput } from "@oh-my-opencode/telemetry-core"

// Releases before the crash-safe session summary (#10225) kept their per-session rollups under
// `<state>/rollups/`. Nothing reads that directory any more and nothing sends from it, so its files are
// data with no reader: every start removes them, whatever the consent, without loading telemetry code.

/** The most entries one start removes; a larger leftover is finished by the next start. */
export const LEGACY_ROLLUP_REMOVE_LIMIT = 1_000

export type LegacyRollupsResult = {
  readonly removed: number
  readonly kept: number
}

const NOTHING: LegacyRollupsResult = { removed: 0, kept: 0 }

const cleaned = new Set<string>()

/** Once per state dir per process: removes the leftovers and logs counts only, never a name or path. */
export function removeLegacyRollupsOnce(stateDir: string, diagnostics?: (input: TelemetryDiagnosticInput) => void): void {
  if (cleaned.has(stateDir)) return
  cleaned.add(stateDir)
  const { removed, kept } = removeLegacyRollups(stateDir)
  if (removed > 0) diagnostics?.({ event: "telemetry_legacy_rollups_removed", source: "omo-native-component", count: removed })
  if (kept > 0) diagnostics?.({ event: "telemetry_activity_state_write_failed", source: "omo-native-component", count: kept })
}

export function legacyRollupDir(stateDir: string): string {
  return join(stateDir, "rollups")
}

/**
 * Removes `<state>/rollups/` without following a link. A `rollups` link is unlinked itself and its target
 * is never read. Inside the directory only files and links are removed (`unlink` never follows), at most
 * `limit` per call; subdirectories are left. The emptied directory is removed last.
 */
export function removeLegacyRollups(stateDir: string, limit: number = LEGACY_ROLLUP_REMOVE_LIMIT): LegacyRollupsResult {
  const dir = legacyRollupDir(stateDir)
  const kind = entryKind(dir)
  if (kind === undefined) return NOTHING
  if (kind === "link") return unlink(dir) ? { removed: 1, kept: 0 } : { removed: 0, kept: 1 }
  if (kind !== "directory") return { removed: 0, kept: 1 }

  let removed = 0
  let kept = 0
  for (const entry of list(dir)) {
    if (removed >= limit || entry.isDirectory() || !(entry.isFile() || entry.isSymbolicLink())) {
      kept += 1
      continue
    }
    if (unlink(join(dir, entry.name))) removed += 1
    else kept += 1
  }
  if (kept === 0) {
    try {
      rmdirSync(dir)
    } catch {
      // Another start emptied and removed it first, or a file arrived meanwhile: the next start retries.
    }
  }
  return { removed, kept }
}

function entryKind(path: string): "directory" | "link" | "other" | undefined {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return "link"
    return stat.isDirectory() ? "directory" : "other"
  } catch {
    return undefined
  }
}

function list(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function unlink(path: string): boolean {
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}
