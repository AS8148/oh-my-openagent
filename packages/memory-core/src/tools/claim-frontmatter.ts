import { createHash } from "node:crypto"

import { parseMemoryFile, renderMemoryFile, type MemoryFrontmatter } from "../memfs/frontmatter"
import { duplicateFrontmatterKeys, lookAlikeFrontmatterKeys, normalizedFrontmatterKey } from "../memfs/frontmatter-entries"
import { RECEIPT_ATTESTATION_PREFIX, renderClaimReceipt, type ClaimReceipt } from "../provenance"

export const PROVENANCE_FRONTMATTER_KEY = "provenance"
export const MIXED_PROVENANCE = "mixed: parts of this note are not verified as the user's own words"
export const UNVERIFIED_USER_PROVENANCE = "unverified: this note changed after the user's approval, so it is not the user's decision"

const USER_PREFIX = "user said "
const BODY_BINDING = / \(body sha256:([0-9a-f]{16})\)$/
const APPROVED_PROPOSAL = / approving proposal ([0-9a-f]{16}) \(body sha256:[0-9a-f]{16}\)$/

export interface StampedNote {
  readonly frontmatter: MemoryFrontmatter
  readonly body: string
}

// The receipt is written into the note itself so a reader that opens the file directly (cat, read)
// sees where its content came from, not only `git log` (#10488). It is harness-owned: whatever the
// written content says for this key is discarded and re-derived from the previous header and the
// verified claim. A note reads as the user's only while every content write to it was user-verified,
// and a user receipt is bound to the body it approved by a digest, so the approval cannot be carried
// onto other content: a reader checks the digest (verifiedUserReceipt) before trusting it.
export function stampReceipt(
  previous: StampedNote | undefined,
  next: MemoryFrontmatter,
  body: string,
  claim: ClaimReceipt | undefined,
): MemoryFrontmatter {
  const prior = previous === undefined ? undefined : readHeader(previous.frontmatter)
  const priorUser = previous !== undefined && prior !== undefined && isBoundUserHeader(prior, previous.body)
  const header = claim === undefined ? unverifiedEditHeader(prior) : mergeHeader(previous === undefined, priorUser, claim, body)
  const rest = Object.fromEntries(Object.entries(next.extra ?? {}).filter(([key]) => normalizedFrontmatterKey(key) !== PROVENANCE_FRONTMATTER_KEY))
  const extra = header === undefined ? rest : { ...rest, [PROVENANCE_FRONTMATTER_KEY]: JSON.stringify(header) }
  const { extra: _extra, ...base } = next
  return Object.keys(extra).length === 0 ? base : { ...base, extra }
}

export function restampContent(previous: string | undefined, next: string, claim: ClaimReceipt | undefined): string {
  const parsed = parseMemoryFile(next)
  const stamped = stampReceipt(previous === undefined ? undefined : parseMemoryFile(previous), parsed.frontmatter, parsed.body, claim)
  const unchanged = JSON.stringify(stamped.extra ?? {}) === JSON.stringify(parsed.frontmatter.extra ?? {})
  return unchanged ? next : renderMemoryFile(stamped, parsed.body)
}

export function bodyDigest(body: string): string {
  return createHash("sha256").update(body.replace(/\r\n/g, "\n").trimEnd(), "utf8").digest("hex").slice(0, 16)
}

// True only for a user receipt whose digest matches this body. Any other header (agent, inferred,
// mixed, none) is not a user decision either, so callers treat false as "not the user's".
export function verifiedUserReceipt(note: StampedNote): boolean {
  const header = readHeader(note.frontmatter)
  return header !== undefined && isBoundUserHeader(header, note.body)
}

// The attestation line the read tool attaches for a note whose user receipt verifies, or undefined. It is issued only
// for the memory tool's exact header: one `provenance` key, no key that merely reads as it (`Provenance`,
// `"provenance"`), and a digest that matches the body. MEMORY_AUTHORITY_RULE tells the model this line is the only
// user approval it may trust, so header text alone, however it is spelled, never counts.
export function receiptAttestation(content: string): string | undefined {
  if (lookAlikeFrontmatterKeys(content, PROVENANCE_FRONTMATTER_KEY).length > 0) return undefined
  if (duplicateFrontmatterKeys(content).includes(PROVENANCE_FRONTMATTER_KEY)) return undefined
  let note: StampedNote
  try {
    note = parseMemoryFile(content)
  } catch {
    return undefined
  }
  if (!verifiedUserReceipt(note)) return undefined
  const proposal = APPROVED_PROPOSAL.exec(readHeader(note.frontmatter) ?? "")?.[1]
  return proposal === undefined ? undefined : `${RECEIPT_ATTESTATION_PREFIX} proposal ${proposal}, body sha256 ok]`
}

export function isUserHeader(header: string | undefined): boolean {
  return header?.startsWith(USER_PREFIX) === true
}

function isBoundUserHeader(header: string, body: string): boolean {
  return header.startsWith(USER_PREFIX) && BODY_BINDING.exec(header)?.[1] === bodyDigest(body)
}

function unverifiedEditHeader(prior: string | undefined): string | undefined {
  return isUserHeader(prior) ? MIXED_PROVENANCE : prior
}

function mergeHeader(created: boolean, priorUser: boolean, claim: ClaimReceipt, body: string): string {
  const rendered = claim.source === "user" ? `${renderClaimReceipt(claim)} (body sha256:${bodyDigest(body)})` : renderClaimReceipt(claim)
  if (created) return rendered
  if ((claim.source === "user") === priorUser) return rendered
  return MIXED_PROVENANCE
}

export function readHeader(frontmatter: MemoryFrontmatter): string | undefined {
  const raw = frontmatter.extra?.[PROVENANCE_FRONTMATTER_KEY]
  if (raw === undefined) return undefined
  try {
    const decoded: unknown = JSON.parse(raw)
    return typeof decoded === "string" ? decoded : raw
  } catch {
    return raw
  }
}
