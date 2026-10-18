import { parseMemoryFile, renderMemoryFile, type MemoryFrontmatter } from "../memfs/frontmatter"
import { renderClaimReceipt, type ClaimReceipt } from "../provenance"

export const PROVENANCE_FRONTMATTER_KEY = "provenance"
export const MIXED_PROVENANCE = "mixed: parts of this note are not verified as the user's own words"

const USER_PREFIX = "user said "

// The receipt is written into the note itself so a reader that opens the file directly (cat, read)
// sees where its content came from, not only `git log` (#10488). It is harness-owned: whatever the
// written content says for this key is discarded and re-derived from the previous header and the
// verified claim. A note reads as the user's only while every content write to it was user-verified.
export function stampReceipt(
  previous: MemoryFrontmatter | undefined,
  next: MemoryFrontmatter,
  claim: ClaimReceipt | undefined,
): MemoryFrontmatter {
  const prior = previous === undefined ? undefined : readHeader(previous)
  const header = claim === undefined ? unverifiedEditHeader(prior) : mergeHeader(previous === undefined, prior, claim)
  const { [PROVENANCE_FRONTMATTER_KEY]: _discarded, ...rest } = next.extra ?? {}
  const extra = header === undefined ? rest : { ...rest, [PROVENANCE_FRONTMATTER_KEY]: JSON.stringify(header) }
  const { extra: _extra, ...base } = next
  return Object.keys(extra).length === 0 ? base : { ...base, extra }
}

export function restampContent(previous: string | undefined, next: string, claim: ClaimReceipt | undefined): string {
  const parsed = parseMemoryFile(next)
  const stamped = stampReceipt(previous === undefined ? undefined : parseMemoryFile(previous).frontmatter, parsed.frontmatter, claim)
  const unchanged = stamped.extra?.[PROVENANCE_FRONTMATTER_KEY] === parsed.frontmatter.extra?.[PROVENANCE_FRONTMATTER_KEY]
  return unchanged ? next : renderMemoryFile(stamped, parsed.body)
}

function unverifiedEditHeader(prior: string | undefined): string | undefined {
  return prior?.startsWith(USER_PREFIX) === true ? MIXED_PROVENANCE : prior
}

function mergeHeader(created: boolean, prior: string | undefined, claim: ClaimReceipt): string {
  const rendered = renderClaimReceipt(claim)
  if (created) return rendered
  const priorUser = prior?.startsWith(USER_PREFIX) === true
  const claimUser = claim.source === "user"
  if (claimUser === priorUser) return rendered
  return MIXED_PROVENANCE
}

function readHeader(frontmatter: MemoryFrontmatter): string | undefined {
  const raw = frontmatter.extra?.[PROVENANCE_FRONTMATTER_KEY]
  if (raw === undefined) return undefined
  try {
    const decoded: unknown = JSON.parse(raw)
    return typeof decoded === "string" ? decoded : raw
  } catch {
    return raw
  }
}
