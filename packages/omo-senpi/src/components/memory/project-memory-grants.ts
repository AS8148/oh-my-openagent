import { realpath, realpathSync } from "@oh-my-opencode/memory-core/fs"
import { isPathInside, type PathContainmentOptions } from "@oh-my-opencode/utils/path-containment"
import * as path from "node:path"

import type { MemoryIdentityContext } from "./context"

// Read-only exceptions to the cross-identity memory denial (#10044). A bound identity may READ the
// committed notes of a project identity the project-scope resolver found inside its session's
// working tree, and only after that resolver returned it. Enumeration, writes, the repo directory
// itself, its git metadata and reserved `system/` tree, and every other identity stay denied. The
// check runs on the canonical path, so a symlink committed into a granted repo cannot reach out of it.
const grants = new WeakMap<MemoryIdentityContext, Set<string>>()

// Compared case-insensitively on every platform: a `.GIT` or `System` entry in a memory repo is
// never note content, and on a case-insensitive volume it is the real git metadata.
const EXCLUDED_TOP_LEVEL = [".git", "system"]

export interface ProjectMemoryGrantOptions {
  /** Canonicalizes the repo; the tool-result path passes its session's memoized lookup. */
  readonly realPath?: (path: string) => Promise<string | undefined>
  /** Checked after canonicalizing: a session that shut down meanwhile is never granted. */
  readonly stillLive?: () => boolean
}

export async function grantProjectMemoryRead(context: MemoryIdentityContext, projectRepo: string, options: ProjectMemoryGrantOptions = {}): Promise<void> {
  const root = await (options.realPath ?? canonicalAsync)(projectRepo)
  if (root === undefined || options.stillLive?.() === false) return
  let roots = grants.get(context)
  if (roots === undefined) {
    roots = new Set()
    grants.set(context, roots)
  }
  roots.add(root)
}

export function revokeProjectMemoryReads(context: MemoryIdentityContext): void {
  grants.delete(context)
}

export function isGrantedProjectMemoryRead(context: MemoryIdentityContext, target: string, options: PathContainmentOptions = {}): boolean {
  const roots = grants.get(context)
  if (roots === undefined || roots.size === 0) return false
  const windows = (options.platform ?? process.platform) === "win32"
  const paths = windows ? path.win32 : path.posix
  const canonicalPath = options.realpath ?? realpathSync.native
  for (const root of roots) {
    try {
      if (!isPathInside(target, root, { ...options, realpath: canonicalPath })) continue
      const rel = paths.relative(canonicalPath(root), canonicalPath(target))
      if (rel === "" || rel.startsWith("..") || paths.isAbsolute(rel)) continue
      const first = rel.split(paths.sep)[0] ?? ""
      if (EXCLUDED_TOP_LEVEL.includes(first.toLowerCase())) continue
      return true
    } catch {
      // An absent or unreadable path is not a read grant; never trust a lexical fallback.
      continue
    }
  }
  return false
}

async function canonicalAsync(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  } catch {
    return undefined
  }
}
