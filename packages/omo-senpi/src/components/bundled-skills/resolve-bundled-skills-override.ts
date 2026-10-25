import { accessSync, constants, readdirSync, statSync } from "node:fs"
import { isAbsolute } from "node:path"

const VARIABLE = "OMO_BUNDLED_SKILLS_DIR"

export class BundledSkillsDirectoryError extends Error {
  constructor(value: string, reason: string, cause?: unknown) {
    super(`${VARIABLE}=${JSON.stringify(value)}: ${reason}`, { cause })
    this.name = "BundledSkillsDirectoryError"
  }
}

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
    readdirSync(value)
  } catch (error) {
    if (error instanceof BundledSkillsDirectoryError) throw error
    throw new BundledSkillsDirectoryError(value, "directory must exist and be readable and searchable", error)
  }
  return value
}
