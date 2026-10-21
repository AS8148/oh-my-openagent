import { readFile } from "../fs/resilient"
import { join } from "node:path"

import type { GitMemoryRepo } from "../git"
import { isLegacyUserHeader, PROVENANCE_STRIPPED_TRAILER, readHeader } from "./claim-frontmatter"
import { parseMemoryFile } from "../memfs/frontmatter"

// The memory tool's record of the one migration (lead decision C on #10498): a path whose HEAD copy carried a legacy
// "user said" header and whose write dropped it, or the source of a move (a deleted path in a batch that also wrote a
// path absent at HEAD) whose header no written file still carries. A plain delete is not an edit and is not recorded.
export async function provenanceStrippedTrailers(repo: GitMemoryRepo, affectedPaths: readonly string[]): Promise<string[]> {
  // One cat-file per affected path (a memory write touches one or two), never a whole-tree listing.
  const atHead = new Map<string, string>()
  for (const path of affectedPaths) {
    const [blob] = (await repo.readBlobs([`HEAD:${path}`])).values()
    if (blob !== undefined) atHead.set(path, blob)
  }
  const legacyAtHead = (path: string): boolean => isLegacyUserHeader(headerOf(atHead.get(path)))
  const written = new Map<string, string | undefined>()
  for (const path of affectedPaths) written.set(path, await readFile(join(repo.dir, path), "utf8").catch(() => undefined))
  const movedIn = [...written].some(([path, content]) => content !== undefined && !atHead.has(path))
  const anyLegacyWritten = [...written.values()].some((content) => isLegacyUserHeader(headerOf(content)))
  return affectedPaths
    .filter((path) => legacyAtHead(path))
    .filter((path) => {
      const content = written.get(path)
      return content === undefined ? movedIn && !anyLegacyWritten : !isLegacyUserHeader(headerOf(content))
    })
    .map((path) => `${PROVENANCE_STRIPPED_TRAILER}: ${path}`)
}

function headerOf(content: string | undefined): string | undefined {
  if (content === undefined) return undefined
  try {
    return readHeader(parseMemoryFile(content).frontmatter)
  } catch {
    return undefined
  }
}
