import { accessSync, constants, statSync } from "node:fs"
import { isAbsolute } from "node:path"

const VARIABLE = "OMO_BUNDLED_SKILLS_DIR"

// omo.js and omo-task.js each carry their own copy of this module, so the "report once" ledgers
// hang off globalThis under registered symbols: one per process, shared by every bundle.
const REPORTED_KEY = Symbol.for("omo.bundledSkills.invalidOverride.reported")
const NOTIFIED_KEY = Symbol.for("omo.bundledSkills.invalidOverride.notified")

export class BundledSkillsDirectoryError extends Error {
  constructor(value: string, reason: string, cause?: unknown) {
    super(`${VARIABLE}=${JSON.stringify(value)}: ${reason}`, { cause })
    this.name = "BundledSkillsDirectoryError"
  }
}

export interface BundledSkillsOverrideLogger {
  error(message: string, details?: unknown): void
}

export type BundledSkillsOverrideNotify = (message: string, type: "error") => void

type OverrideOutcome =
  | { readonly kind: "resolved"; readonly dir: string | undefined }
  | { readonly kind: "invalid"; readonly message: string; readonly cause: unknown }

const stderrLogger: BundledSkillsOverrideLogger = { error: (message) => console.error(message) }

export function resolveBundledSkillsOverride(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const value = env[VARIABLE]
  if (value === undefined || value === "") return undefined
  if (!isAbsolute(value)) throw new BundledSkillsDirectoryError(value, "an absolute directory path is required")
  try {
    if (!statSync(value).isDirectory()) {
      throw new BundledSkillsDirectoryError(value, "not a directory")
    }
    accessSync(value, constants.R_OK | constants.X_OK)
  } catch (error) {
    if (error instanceof BundledSkillsDirectoryError) throw error
    throw new BundledSkillsDirectoryError(value, "directory must exist and be readable and searchable", error)
  }
  return value
}

export function resolveBundledSkillsOverrideOrFallback(
  env: Record<string, string | undefined> = process.env,
  logger: BundledSkillsOverrideLogger = stderrLogger,
): string | undefined {
  const outcome = checkOverride(env)
  if (outcome.kind === "resolved") return outcome.dir
  report(outcome, logger)
  return undefined
}

export function notifyInvalidBundledSkillsOverride(
  env: Record<string, string | undefined>,
  logger: BundledSkillsOverrideLogger,
  notify: BundledSkillsOverrideNotify | undefined,
): void {
  const outcome = checkOverride(env)
  if (outcome.kind === "resolved") return
  report(outcome, logger)
  if (notify !== undefined && claim(NOTIFIED_KEY, outcome.message)) notify(outcome.message, "error")
}

function checkOverride(env: Record<string, string | undefined>): OverrideOutcome {
  try {
    return { kind: "resolved", dir: resolveBundledSkillsOverride(env) }
  } catch (error) {
    if (!(error instanceof BundledSkillsDirectoryError)) throw error
    return { kind: "invalid", message: `${error.message}; using the plugin's bundled skills instead`, cause: error.cause }
  }
}

function report(outcome: Extract<OverrideOutcome, { kind: "invalid" }>, logger: BundledSkillsOverrideLogger): void {
  if (claim(REPORTED_KEY, outcome.message)) logger.error(outcome.message, { variable: VARIABLE, cause: outcome.cause })
}

function claim(key: symbol, message: string): boolean {
  const registry = globalThis as unknown as Record<symbol, unknown>
  const existing = registry[key]
  const seen = existing instanceof Set ? existing : new Set<unknown>()
  registry[key] = seen
  if (seen.has(message)) return false
  seen.add(message)
  return true
}
