// Item keys (sync-design §1): the sync identity of a file is its repo-relative path with
// "/" separators, Unicode NFC, then the vendored full case fold, so a case-insensitive
// file system can never split one item into two. `..` segments, absolute paths, NUL and
// the empty path are never items.

import { caseFold } from "./casefold"

export function normalizeItemKey(path: string): string | null {
  if (path === "" || path.includes("\0") || path.startsWith("/")) return null
  const normalized = path.normalize("NFC")
  for (const segment of normalized.split("/")) {
    if (segment === "..") return null
  }
  return caseFold(normalized)
}
