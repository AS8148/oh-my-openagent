import * as fs from "node:fs"
import { checkSkillPath, SkillLinkBlockedError, type SkillProvenance } from "./skill-provenance"

/**
 * Containment assumes the filesystem is stable during loading. Descriptor identity
 * detects some concurrent replacements, not ancestor-directory swaps.
 */
export function readSkillFileChecked(path: string, provenance: SkillProvenance): string {
  if (provenance.kind !== "project-auto") return fs.readFileSync(path, "utf8")
  const canonical = checkSkillPath(path, provenance)
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const opened = fs.fstatSync(descriptor)
    const current = fs.statSync(canonical)
    if (!opened.isFile() || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new SkillLinkBlockedError(path, canonical)
    }
    return fs.readFileSync(descriptor, "utf8")
  } catch (error) {
    if (error instanceof SkillLinkBlockedError) throw error
    throw new SkillLinkBlockedError(path, canonical)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}
