import { realpathSync } from "node:fs"
import { relative, resolve, isAbsolute, sep } from "node:path"

import { ALLOWED_EXTENSIONS } from "./constants"
import { resolveFileWritePath } from "../../shared/resolve-file-write-path"

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** Return the authorized physical path; the hook passes this exact value to the tool. */
export function resolveAllowedFile(filePath: string, workspaceRoot: string): string | undefined {
  try {
    const input = filePath.replace(/\\/g, sep)
    const planning = [...input.matchAll(/(?:^|[/\\])\.omo(?=[/\\]|$)/gi)].at(-1)
    if (planning === undefined) return undefined
    const prefix = input.slice(0, planning.index + planning[0].length)
    if (!isInside(resolve(workspaceRoot, prefix), resolve(workspaceRoot))) return undefined

    const realRoot = realpathSync.native(workspaceRoot)
    const planningRoot = resolveFileWritePath(prefix, workspaceRoot)
    if (planningRoot !== realRoot && !isInside(planningRoot, realRoot)) return undefined
    const destination = resolveFileWritePath(filePath, workspaceRoot)
    if (!isInside(destination, planningRoot)) return undefined
    return ALLOWED_EXTENSIONS.some(ext =>
      input.toLowerCase().endsWith(ext) && destination.toLowerCase().endsWith(ext),
    ) ? destination : undefined
  } catch {
    // Includes dangling links, loops, non-directory ancestors and inaccessible paths.
    return undefined
  }
}

export function isAllowedFile(filePath: string, workspaceRoot: string): boolean {
  return resolveAllowedFile(filePath, workspaceRoot) !== undefined
}
