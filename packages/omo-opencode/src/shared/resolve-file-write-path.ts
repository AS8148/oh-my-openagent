import { lstatSync, realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, parse, sep } from "node:path"

/**
 * Resolve a write destination physically, including new parents. Never collapse
 * `link/..` textually: the parent is taken only after the link has been followed.
 * The returned absolute path must also be the path handed to the executor.
 */
export function resolveFileWritePath(filePath: string, cwd: string): string {
  const input = filePath.replace(/\\/g, sep)
  const absolute = isAbsolute(input) ? input : `${realpathSync.native(cwd)}${sep}${input}`
  const root = parse(absolute).root
  let current = realpathSync.native(root)
  let directory = true

  for (const component of absolute.slice(root.length).split(sep).filter(Boolean)) {
    if (!directory) throw new Error(`Not a directory: ${current}`)
    if (component === ".") continue
    if (component === "..") {
      current = dirname(current)
      continue
    }
    const next = join(current, component)
    let entry
    try {
      entry = lstatSync(next)
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
      current = next
      continue
    }
    // A dangling link must fail here, not become a new-file ENOENT fallback.
    current = realpathSync.native(next)
    directory = entry.isSymbolicLink() ? statSync(current).isDirectory() : entry.isDirectory()
  }
  return current
}
