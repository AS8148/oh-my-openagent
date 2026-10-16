import { type AnchorRejection, anchorStep, type ChainAnchor, type PinCandidate } from "./anchor.ts"
import type { BatchEntry, Head, KeyringEntry, SyncAuthor, SyncEntry, VerifiedKeyringEntry, VerifiedWrap } from "./entry.ts"
import { type EnvelopeRejection, envelopeRefusal } from "./envelope.ts"
import { type Authority, applyRecord, type FoldedRecord, isCancelledAdmission, isVetoedEpoch } from "./fold.ts"
import { nextLink } from "./links.ts"
import { type ParsedBody, parseBody } from "./parse.ts"
import type { RejectionCounter } from "./rejection.ts"
import { type ReceiverCheck, receiverRefusal } from "./receiver.ts"
import { checkRecordRules, type RuleRejection } from "./rules.ts"
import { authorSigningKey, verifyRecordSig } from "./signatures.ts"
import { jcsBytes, sha256B64 } from "./vendor/sync-format/jcs.ts"

export type ChainRejection =
  | RuleRejection
  | ReceiverCheck
  | EnvelopeRejection
  | AnchorRejection
  | "forced_rotation_required"
  | "bad_fork_resolution"
  | "bad_record"
  | "link_mismatch"
  | "not_member"
  | "bad_signature"
  | "epoch_mismatch"
  | "account_mismatch"
  | "digest_mismatch"

export type ChainState = {
  readonly account: string
  readonly head: Head | null
  readonly authority: Authority | null
  readonly history: ReadonlyArray<FoldedRecord>
  /** Every verified keyring entry of an ANCHORED chain, wraps minted: the merged receiver re-reads them. */
  readonly received: ReadonlyArray<VerifiedKeyringEntry>
  /** The device's trust anchor; nothing is trusted and no wrap is minted until the chain meets it. */
  readonly anchor: ChainAnchor
  readonly anchored: boolean
  /** Verified keyring entries walked before the anchor was met: never minted, never handed out. */
  readonly unanchored: ReadonlyArray<KeyringEntry>
  readonly genesisDigest: string | null
  /** The root a bootstrap walk proved, for the pin store; null for a chain walked under a pin. */
  readonly pin: PinCandidate | null
  /** The seq of a fork-resolution whose forced rotation must come next (spec 8.2), else null. */
  readonly forcedRotationAfter: number | null
}

const minted = new WeakSet<object>()

const isMinted = (wrap: object): wrap is VerifiedWrap => minted.has(wrap)

/** True only for a wrap this module minted from a verified keyring entry, never for a copy. */
export const isVerifiedWrap = (wrap: unknown): wrap is VerifiedWrap =>
  typeof wrap === "object" && wrap !== null && isMinted(wrap)

const mintWraps = (entry: KeyringEntry): VerifiedKeyringEntry => ({
  ...entry,
  wraps: entry.wraps
    .map((wrap) => {
      const sealed = Object.freeze({ epoch: wrap.epoch, id: wrap.id, wrap: wrap.wrap, account: entry.account })
      minted.add(sealed)
      return sealed
    })
    .filter(isMinted),
})

export type AcceptedBatch = {
  readonly seq: number
  readonly digest: string
  readonly epoch: number
  readonly authorId: string
  readonly signingPublicKey: string
}

export type ChainStep =
  | { readonly kind: "keyring"; readonly seq: number; readonly record: ParsedBody["kind"] }
  | { readonly kind: "batch"; readonly batch: AcceptedBatch }
  | { readonly kind: "vetoed"; readonly seq: number }

export type AppendOutcome =
  | { readonly ok: true; readonly state: ChainState; readonly steps: ReadonlyArray<ChainStep> }
  | {
      readonly ok: false
      readonly state: ChainState
      readonly steps: ReadonlyArray<ChainStep>
      readonly seq: number
      readonly reason: ChainRejection
    }

export const emptyChain = (account: string, anchor: ChainAnchor): ChainState => ({
  account,
  head: null,
  authority: null,
  history: [],
  received: [],
  anchor,
  anchored: false,
  unanchored: [],
  genesisDigest: null,
  pin: null,
  forcedRotationAfter: null,
})

const seenKeyring = (state: ChainState): ReadonlyArray<KeyringEntry> => [...state.received, ...state.unanchored]

const forcedRotationRefusal = (state: ChainState, body: ParsedBody | null): ChainRejection | null => {
  const fork = body?.kind === "rotation" ? body.forkResolution : null
  if (state.forcedRotationAfter !== null) return fork === state.forcedRotationAfter ? null : "forced_rotation_required"
  return fork === null ? null : "bad_fork_resolution"
}

/** Main-chain mode checks seq, base_seq and link; keyring-only mode (snapshot import) checks the sub-chain alone. */
export type LinkMode = "main" | "keyring-only"

const linksHold = async (state: ChainState, entry: SyncEntry, mode: LinkMode): Promise<boolean> => {
  const head = state.head
  const priorSeq = head === null ? 0 : head.seq
  if (mode === "main") {
    if (entry.base_seq !== priorSeq || entry.seq !== priorSeq + 1) return false
    if (entry.link !== (await nextLink(head === null ? "" : head.link, entry.digest))) return false
  } else if (entry.seq <= priorSeq || entry.base_seq !== entry.seq - 1) {
    return false
  }
  if (entry.kind === "batch") return entry.keyring_link === null
  return entry.keyring_link === (await nextLink(head === null ? "" : head.keyring_link, entry.digest))
}

const signerKey = (
  body: ParsedBody,
  before: Authority | null,
  author: SyncAuthor,
  history: ReadonlyArray<FoldedRecord>,
): string | null => {
  if (body.kind === "genesis") {
    return author.kind === "device" && author.id === body.firstDevice.id ? body.firstDevice.signing_public_key : null
  }
  if (before === null) return null
  if (body.kind === "recovery-join") {
    return author.kind === "recovery" && author.credential_id === body.credentialId
      ? authorSigningKey(before, author)
      : null
  }
  if (author.kind !== "device") return null
  if (body.kind === "recovery-join-vetoed") {
    const join = history.find((record) => record.digest === body.joinDigest)
    return join?.before == null ? null : authorSigningKey(join.before, author)
  }
  if (isCancelledAdmission(before, author.id)) return null
  return authorSigningKey(before, author)
}

const expectedEpoch = (body: ParsedBody, before: Authority | null): number | null => {
  if (body.kind === "genesis") return 1
  if (body.kind === "fork-resolution") return body.epoch
  if (before === null) return null
  return body.kind === "rotation" ? before.epoch + 1 : before.epoch
}

type StepResult =
  | { readonly ok: true; readonly state: ChainState; readonly step: ChainStep }
  | { readonly ok: false; readonly reason: ChainRejection }

/**
 * One keyring record through the receiver order of sync-design section 6: chain link,
 * record signature (against the authority folded from every earlier keyring record),
 * epoch, account binding, the per-kind rules of the section 8.2 verifier table, and
 * finally the content hash. Right after the link, the merged receiver's own refusals apply, so a
 * record it refuses is never folded here either.
 */
export const verifyKeyringEntry = async (state: ChainState, entry: KeyringEntry, mode: LinkMode): Promise<StepResult> => {
  const malformed = envelopeRefusal(entry)
  if (malformed !== null) return { ok: false, reason: malformed }
  if (state.anchor.account !== state.account) return { ok: false, reason: "untrusted_root" }
  if (!(await linksHold(state, entry, mode))) return { ok: false, reason: "link_mismatch" }
  const refused = await receiverRefusal(seenKeyring(state), entry)
  if (refused !== null) return { ok: false, reason: refused }
  const body = parseBody(entry.body)
  if (body === null) return { ok: false, reason: "bad_record" }
  const before = state.authority
  const key = signerKey(body, before, entry.author, state.history)
  if (key === null) return { ok: false, reason: "not_member" }
  if (!(await verifyRecordSig(key, entry))) return { ok: false, reason: "bad_signature" }
  if (entry.epoch !== expectedEpoch(body, before) || entry.body.epoch !== entry.epoch) {
    return { ok: false, reason: "epoch_mismatch" }
  }
  if (entry.account !== state.account || entry.body.account !== state.account) {
    return { ok: false, reason: "account_mismatch" }
  }
  const predecessor = state.head === null ? "" : state.head.keyring_link
  const ruleFailure = await checkRecordRules(entry, body, before, state.history, predecessor)
  if (ruleFailure !== null) return { ok: false, reason: ruleFailure }
  if ((await sha256B64(jcsBytes(entry.body))) !== entry.digest) return { ok: false, reason: "digest_mismatch" }
  const forced = forcedRotationRefusal(state, body)
  if (forced !== null) return { ok: false, reason: forced }
  const genesisDigest = body.kind === "genesis" ? entry.digest : state.genesisDigest
  const met = state.anchored ? null : anchorStep(state.anchor, entry, body, before, genesisDigest ?? "")
  if (met !== null && !met.ok) return { ok: false, reason: met.reason }
  const record: FoldedRecord = { seq: entry.seq, digest: entry.digest, body, before }
  const authority = applyRecord(state.history, record)
  if (authority === null) return { ok: false, reason: "bad_record" }
  const anchored = state.anchored || met?.anchored === true
  return {
    ok: true,
    state: {
      ...state,
      head: { seq: entry.seq, link: entry.link, keyring_link: entry.keyring_link },
      authority,
      history: [...state.history, record],
      received: anchored ? [...state.received, ...[...state.unanchored, entry].map(mintWraps)] : state.received,
      anchored,
      unanchored: anchored ? [] : [...state.unanchored, entry],
      genesisDigest,
      pin: met?.ok === true && met.candidate !== null ? met.candidate : state.pin,
      forcedRotationAfter: body.kind === "fork-resolution" ? entry.seq : null,
    },
    step: { kind: "keyring", seq: entry.seq, record: body.kind },
  }
}

/**
 * The author's signing key as it stood inside `epoch`: the newest folded authority of that epoch
 * that holds the author. A vetoed epoch's members are no longer in the current fold, so their
 * batches verify against the position they were written at, and an author never a member there
 * gets no key.
 */
const keyWithinEpoch = (state: ChainState, author: SyncAuthor, epoch: number): string | null => {
  const after = state.history.map((_, index) => state.history[index + 1]?.before ?? state.authority)
  for (const authority of after.reverse()) {
    const key = authority !== null && authority.epoch === epoch ? authorSigningKey(authority, author) : null
    if (key !== null) return key
  }
  return null
}

const verifyBatchEntry = async (state: ChainState, entry: BatchEntry): Promise<StepResult> => {
  const malformed = envelopeRefusal(entry)
  if (malformed !== null) return { ok: false, reason: malformed }
  if (!(await linksHold(state, entry, "main"))) return { ok: false, reason: "link_mismatch" }
  const refused = await receiverRefusal(seenKeyring(state), entry)
  if (refused !== null) return { ok: false, reason: refused }
  const forced = forcedRotationRefusal(state, null)
  if (forced !== null) return { ok: false, reason: forced }
  const authority = state.authority
  const head = state.head
  if (authority === null || head === null || entry.author.kind !== "device") return { ok: false, reason: "not_member" }
  const next: ChainState = { ...state, head: { seq: entry.seq, link: entry.link, keyring_link: head.keyring_link } }
  const authorId = entry.author.id
  const vetoed = isVetoedEpoch(authority, entry.epoch) || isCancelledAdmission(authority, authorId)
  const key = vetoed ? keyWithinEpoch(state, entry.author, entry.epoch) : authorSigningKey(authority, entry.author)
  if (key === null) return { ok: false, reason: "not_member" }
  if (!(await verifyRecordSig(key, entry))) return { ok: false, reason: "bad_signature" }
  if (entry.account !== state.account) return { ok: false, reason: "account_mismatch" }
  if (vetoed) return { ok: true, state: next, step: { kind: "vetoed", seq: entry.seq } }
  if (entry.epoch !== authority.epoch) return { ok: false, reason: "epoch_mismatch" }
  const batch: AcceptedBatch = { seq: entry.seq, digest: entry.digest, epoch: entry.epoch, authorId, signingPublicKey: key }
  return { ok: true, state: next, step: { kind: "batch", batch } }
}

/**
 * Extends the local verified chain entry by entry. The first refused entry stops the walk,
 * counts one content-free rejection and leaves the state at the last verified entry;
 * vetoed-epoch batches advance the cursor without being applied. A walk that does not meet the
 * device's trust anchor hands out nothing: it is refused as a whole (`unanchored`, or the anchor
 * refusal itself) and the input state comes back unchanged, with no steps and no minted wrap.
 */
export const appendEntries = async (
  state: ChainState,
  entries: ReadonlyArray<SyncEntry>,
  rejections: RejectionCounter,
): Promise<AppendOutcome> => {
  let current = state
  const steps: ChainStep[] = []
  for (const entry of entries) {
    const malformed = envelopeRefusal(entry)
    const result: StepResult =
      malformed !== null
        ? { ok: false, reason: malformed }
        : entry.kind === "keyring"
          ? await verifyKeyringEntry(current, entry, "main")
          : await verifyBatchEntry(current, entry)
    if (!result.ok) {
      rejections.record(result.reason)
      const seq = malformed === null && Number.isSafeInteger(entry.seq) ? entry.seq : (current.head?.seq ?? 0) + 1
      return current.anchored
        ? { ok: false, state: current, steps, seq, reason: result.reason }
        : { ok: false, state, steps: [], seq, reason: result.reason }
    }
    current = result.state
    steps.push(result.step)
  }
  if (!current.anchored) {
    rejections.record("unanchored")
    return { ok: false, state, steps: [], seq: (current.head?.seq ?? 0) + 1, reason: "unanchored" }
  }
  return { ok: true, state: current, steps }
}
