import { appendEntries, type ChainState, emptyChain } from "../crypto/chain.ts"
import type { BatchEntry, SyncEntry, WrapEntry } from "../crypto/entry.ts"
import type { Authority } from "../crypto/fold.ts"
import type { RejectionCounter } from "../crypto/rejection.ts"
import type { RecoveryCandidate, RecoveryTransport, RecoveryWrapRow } from "./ports.ts"

export type ServedChain = { readonly ok: true; readonly state: ChainState } | { readonly ok: false; readonly reason: "unavailable" | "unverified" }

const sameWrap = (left: WrapEntry, right: WrapEntry): boolean => left.epoch === right.epoch && left.id === right.id && left.wrap === right.wrap

/**
 * The bootstrap reads joined into one main chain and verified from genesis (sync-design section 7,
 * recovery step 3): each `GET /sync/entries` keyring row must carry the body and wraps of the
 * `GET /sync/keys` row with the same seq and digest, and every entry passes the client receiver.
 */
export const loadServedChain = async (transport: RecoveryTransport, account: string, rejections: RejectionCounter): Promise<ServedChain> => {
  const [rows, keys] = await Promise.all([transport.listEntries(), transport.listKeys()])
  if (rows === null || keys === null) return { ok: false, reason: "unavailable" }
  const bySeq = new Map(keys.map((entry) => [entry.seq, entry]))
  const entries: SyncEntry[] = []
  for (const row of rows) {
    if (row.kind === "batch") {
      const batch: BatchEntry = { ...row, kind: "batch", keyring_link: null }
      entries.push(batch)
      continue
    }
    const keyring = bySeq.get(row.seq)
    if (keyring === undefined || keyring.digest !== row.digest || keyring.keyring_link !== row.keyring_link) {
      return { ok: false, reason: "unverified" }
    }
    entries.push(keyring)
  }
  const appended = await appendEntries(emptyChain(account), entries, rejections)
  if (!appended.ok || appended.state.authority === null) return { ok: false, reason: "unverified" }
  return { ok: true, state: appended.state }
}

/** Earlier non-cancelled epochs and their creating records, as a wrap of `epoch` must carry them. */
export const expectedHistory = (authority: Authority, epoch: number): ReadonlyArray<readonly [number, string]> =>
  [...authority.epochOrigins].filter(([candidate, origin]) => candidate < epoch && !authority.cancelled.has(origin)).sort(([left], [right]) => left - right)

/** The wrap addressed to `id` at `epoch`, taken only from verified, digest-committed records. */
export const committedWrap = (state: ChainState, epoch: number, id: string): WrapEntry | null => {
  for (const entry of [...state.received].reverse()) {
    if (state.authority?.cancelled.has(entry.digest) === true) continue
    const found = entry.wraps.find((wrap) => wrap.epoch === epoch && wrap.id === id)
    if (found !== undefined) return found
  }
  return null
}

type Enrolling = { readonly countersign: string; readonly wrapsDigest: string; readonly predecessor: string }

const enrollingRecord = (state: ChainState, credentialId: string): Enrolling | null => {
  for (const [index, record] of state.history.entries()) {
    const body = record.body
    const predecessor = index === 0 ? "" : (state.received[index - 1]?.keyring_link ?? "")
    if (body.kind === "genesis" && body.recoveryKey.credential_id === credentialId) {
      return { countersign: body.countersign, wrapsDigest: body.wrapsDigest, predecessor }
    }
    if (body.kind === "recovery-key" && body.key.credential_id === credentialId) {
      return { countersign: body.countersign, wrapsDigest: body.wrapsDigest, predecessor }
    }
  }
  return null
}

/**
 * Every recovery key enrolled and not removed at the served head, with the countersignature of the
 * record that enrolled it and its current-epoch wrap. A served recovery-wrap row is used only when
 * it names a verified record and equals a wrap that record committed.
 */
export const recoveryCandidates = (state: ChainState, served: ReadonlyArray<RecoveryWrapRow>): ReadonlyArray<RecoveryCandidate> => {
  const authority = state.authority
  if (authority === null) return []
  const candidates: RecoveryCandidate[] = []
  for (const key of authority.registry.values()) {
    const enrolling = enrollingRecord(state, key.credential_id)
    const committed = committedWrap(state, authority.epoch, `recovery:${key.credential_id}`)
    if (enrolling === null || committed === null) continue
    const row = served.find((candidate) => sameWrap(candidate.entry, committed))
    const anchored = row !== undefined && state.received.some((entry) => entry.seq === row.record.seq && entry.digest === row.record.digest && entry.keyring_link === row.record.keyring_link && entry.wraps.some((wrap) => sameWrap(wrap, committed)))
    if (!anchored) continue
    candidates.push({
      key,
      countersign: {
        custodyRoot: authority.custodyRoot,
        predecessor: enrolling.predecessor,
        wrapsDigest: enrolling.wrapsDigest,
        signature: enrolling.countersign,
      },
      wrap: committed,
      expectedHistory: expectedHistory(authority, authority.epoch),
    })
  }
  return candidates
}
