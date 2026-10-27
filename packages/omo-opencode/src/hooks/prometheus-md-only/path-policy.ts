import { lstatSync, realpathSync } from "node:fs"
import { basename, dirname, relative, resolve, isAbsolute, sep } from "node:path"

import { ALLOWED_EXTENSIONS } from "./constants"

/** Missing components are appended only after an existing ancestor resolves successfully. */
function canonicalDestination(path: string): string {
  const missing: string[] = []
  let ancestor = path
  for (;;) {
    try {
      lstatSync(ancestor)
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      missing.unshift(basename(ancestor))
      ancestor = parent
      continue
    }
    // Keep this outside the ENOENT handler: a dangling symlink is not a missing file.
    return resolve(realpathSync.native(ancestor), ...missing)
  }
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** Check normalized executors and executors that pass an absolute path through unchanged. */
export function isAllowedFile(filePath: string, workspaceRoot: string): boolean {
  try {
    const resolved = resolve(workspaceRoot, filePath)
    const lexicalRelative = relative(resolve(workspaceRoot), resolved)
    if (lexicalRelative.split(sep)[0]?.toLowerCase() !== ".omo") return false

    // Anchor to the real project root, not a potentially redirected `.omo` directory.
    const allowedRoot = resolve(realpathSync.native(workspaceRoot), ".omo")
    // write/edit may open an absolute path verbatim; patch executors normalize it.
    // Check both: collapsing `link/..` before native realpath can hide a redirect.
    const paths = isAbsolute(filePath) && filePath !== resolved ? [resolved, filePath] : [resolved]
    return paths.every(path => {
      const destination = canonicalDestination(path)
      return isInside(destination, allowedRoot) && ALLOWED_EXTENSIONS.some(
        ext => path.toLowerCase().endsWith(ext) && destination.toLowerCase().endsWith(ext),
      )
    })
  } catch {
    // Includes dangling links, loops, non-directory ancestors and inaccessible paths.
    return false
  }
}
