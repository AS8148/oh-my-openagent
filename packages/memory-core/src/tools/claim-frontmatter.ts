import type { MemoryFrontmatter } from "../memfs"
import { renderClaimReceipt } from "../provenance"
import type { MemoryToolProvenance } from "./memory"

export const PROVENANCE_FRONTMATTER_KEY = "provenance"

// The receipt is written into the note itself so a reader that opens the file directly (cat, read)
// sees where its latest change came from, not only `git log` (#10488).
export function withReceipt(
  frontmatter: MemoryFrontmatter,
  params: { readonly provenance?: MemoryToolProvenance },
): MemoryFrontmatter {
  const claim = params.provenance?.claim
  if (claim === undefined) return frontmatter
  return {
    ...frontmatter,
    extra: { ...frontmatter.extra, [PROVENANCE_FRONTMATTER_KEY]: JSON.stringify(renderClaimReceipt(claim)) },
  }
}
