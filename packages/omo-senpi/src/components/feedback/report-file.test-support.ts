import { expect } from "bun:test"
import { statSync } from "node:fs"
import { isAbsolute, relative } from "node:path"

/**
 * A saved report or ledger is private on every platform because it lives inside the per-user state root; POSIX also
 * gets owner-only mode bits. On Windows this proves the location only: NTFS has no mode bits, and the file's privacy
 * comes from the per-user directory's inherited ACL, which statSync cannot read.
 */
export const expectUserOnly = (path: string, root: string): void => {
  const inside = relative(root, path)
  expect(inside === "" || inside.startsWith("..") || isAbsolute(inside)).toBe(false)
  if (process.platform !== "win32") expect(statSync(path).mode & 0o077).toBe(0)
}
