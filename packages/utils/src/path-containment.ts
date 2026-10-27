import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { posix, win32 } from "node:path"

/** macOS autofs triggers (`auto_home`, `-hosts`); resolving a path through one opens it and can block forever (#11545). */
const DARWIN_AUTOMOUNT_TRIGGERS = ["/home", "/net"]

export interface AutomountTriggerOptions {
  readonly platform?: NodeJS.Platform
  /** The current user's home; its own subtree has already resolved its trigger, so it stays resolvable. */
  readonly homeDir?: string
}

/**
 * Whether resolving `path` (realpath, lstat or stat of it or anything under it) would force a macOS automount.
 * When the automounter is wedged that `open(2)` never returns and parks the calling thread, so no timer or
 * promise deadline can bound it (#11545, senpi#4542/#4543). Decided from the string alone, before any syscall:
 * true only on darwin, only for `/home`, `/net` or a path under them, and never for the user's own home subtree.
 * Callers treat such a path as an opaque lexical string. Linux, where `/home` is a real directory, is unchanged.
 */
export function isDarwinAutomountTriggerPath(path: string, options: AutomountTriggerOptions = {}): boolean {
  if ((options.platform ?? process.platform) !== "darwin") return false
  const lexical = posix.resolve(path)
  if (!DARWIN_AUTOMOUNT_TRIGGERS.some((trigger) => lexical === trigger || lexical.startsWith(`${trigger}/`))) return false
  const home = posix.resolve(options.homeDir ?? homedir())
  return home === "/" || !(lexical === home || lexical.startsWith(`${home}/`))
}

export interface PathContainmentOptions {
  readonly platform?: NodeJS.Platform
  /** Native filesystem realpath lookup; injected only for alternate filesystems/tests. */
  readonly realpath?: (path: string) => string
}

/**
 * Includes the parent itself. Both paths must exist: native realpath errors propagate,
 * so callers must map an unresolvable path to their denied/not-inside outcome.
 * Mirrors Senpi canonicalizePathStrict (#1463, 5d78ba39d).
 * Guarantee: each path is first resolved lexically (`path.resolve`, which collapses `..`
 * textually), then canonicalized with the native realpath, and the verdict is about that
 * resolved path. A caller must OPEN the same `path.resolve`d path it checked (Senpi's
 * built-in tools do). Opening the raw string instead can reach a different file on POSIX,
 * where the kernel follows a symlink before applying a later `..`.
 * Windows compares normalized long names case-insensitively; POSIX preserves case.
 * Import from @oh-my-opencode/utils/path-containment.
 */
export function isPathInside(child: string, parent: string, options: PathContainmentOptions = {}): boolean {
  return containedRelativePath(child, parent, options) !== undefined
}

/** The canonical child's path relative to the canonical parent ("" for the parent itself), or undefined when outside. */
export function containedRelativePath(child: string, parent: string, options: PathContainmentOptions = {}): string | undefined {
  const paths = (options.platform ?? process.platform) === "win32" ? win32 : posix
  const realpath = options.realpath ?? realpathSync.native
  const canonicalChild = paths.normalize(realpath(paths.resolve(child)))
  const canonicalParent = paths.normalize(realpath(paths.resolve(parent)))
  const relative = paths.relative(canonicalParent, canonicalChild)
  const escapes = relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)
  return escapes ? undefined : relative
}
