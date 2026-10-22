import { realpathSync } from "node:fs"
import { posix, win32 } from "node:path"

export interface PathContainmentOptions {
  readonly platform?: NodeJS.Platform
  /** Native filesystem realpath lookup; injected only for alternate filesystems/tests. */
  readonly realpath?: (path: string) => string
}

/**
 * Includes the parent itself. Both paths must exist: native realpath errors propagate,
 * so callers must map an unresolvable path to their denied/not-inside outcome.
 * Mirrors Senpi canonicalizePathStrict (#1463, 5d78ba39d). Never resolve or normalize
 * before realpath: doing so collapses dot-dot before the kernel follows symlinks.
 * Windows compares normalized long names case-insensitively; POSIX preserves case.
 * Import from @oh-my-opencode/utils/path-containment.
 */
export function isPathInside(child: string, parent: string, options: PathContainmentOptions = {}): boolean {
  const windows = (options.platform ?? process.platform) === "win32"
  const paths = windows ? win32 : posix
  const realpath = options.realpath ?? realpathSync.native
  const canonicalChild = paths.normalize(realpath(child))
  const canonicalParent = paths.normalize(realpath(parent))
  const relative = paths.relative(canonicalParent, canonicalChild)
  return relative === "" || (!relative.startsWith("..") && !paths.isAbsolute(relative))
}
