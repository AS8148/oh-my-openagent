// This device's verified view of the account's sequence. It starts from the pinned trust anchor,
// walks every served row through the client chain, and extends on demand as the engine pulls. A
// row is usable only after the chain verified it; a refused row is remembered with its reason, and
// nothing after it is verified. Epoch keys open only from wraps the verified chain minted.

import type { TrustAnchor } from "../crypto/anchor.ts"
import { type AcceptedBatch, appendEntries, type ChainRejection, type ChainState, emptyChain } from "../crypto/chain.ts"
import type { BatchEntry, KeyringEntry, SyncEntry } from "../crypto/entry.ts"
import type { RejectionCounter } from "../crypto/rejection.ts"
import type { DeviceKeyring } from "../keyring-port.ts"
import { ownMaterial } from "../recovery/keyring-append.ts"
import { committedWrap, expectedHistory } from "../recovery/served-chain.ts"
import type { AccountHttp } from "./http.ts"

export type ChainPosition =
  | { readonly kind: "batch"; readonly batch: AcceptedBatch }
  | { readonly kind: "keyring" }
  | { readonly kind: "vetoed" }
  | { readonly kind: "refused"; readonly reason: ChainRejection | "unavailable" }
  | { readonly kind: "unknown" }

export interface AccountChain {
  readonly account: string
  state(): ChainState
  /** Verifies served rows until `seq` is known (or the chain refuses before it). */
  reach(seq: number): Promise<ChainPosition>
  /** The verified link at `seq`, or null when the chain has not verified that position. */
  linkAt(seq: number): string | null
  /** The epoch key this device holds for `epoch`, opened from its own committed wrap. */
  epochKey(epoch: number): Promise<Uint8Array<ArrayBuffer> | null>
  isMember(): boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

export async function openAccountChain(input: {
  readonly account: string
  readonly anchor: TrustAnchor
  readonly keyring: DeviceKeyring
  readonly http: AccountHttp
  readonly rejections: RejectionCounter
}): Promise<AccountChain> {
  const { account, keyring, http, rejections } = input
  let state = emptyChain(account, input.anchor)
  const positions = new Map<number, ChainPosition>()
  const links = new Map<number, string>()
  let refusedAt: number | null = null
  const keys = new Map<number, Uint8Array<ArrayBuffer>>()
  let keysEpoch = -1

  const extend = async (): Promise<void> => {
    const after = state.head?.seq ?? 0
    const rows = await http.listEntriesAfter(after)
    if (rows === null || !rows.every(isRecord)) throw new Error("account sync: the entries read did not answer a list")
    if (rows.length === 0) return
    const keyring = rows.some((row) => row.kind === "keyring") ? await http.listKeys() : []
    if (keyring === null || !keyring.every(isRecord)) throw new Error("account sync: the keyring read did not answer a list")
    const bySeq = new Map(keyring.map((entry) => [entry.seq, entry]))
    const entries: SyncEntry[] = []
    for (const row of rows) {
      if (row.kind === "batch") {
        entries.push({ ...row, kind: "batch", keyring_link: null } satisfies BatchEntry)
        continue
      }
      const full: KeyringEntry | undefined = bySeq.get(row.seq)
      if (full === undefined || full.digest !== row.digest || full.keyring_link !== row.keyring_link) {
        positions.set(row.seq, { kind: "refused", reason: "digest_mismatch" })
        refusedAt = row.seq
        return
      }
      entries.push(full)
    }
    const walked = await appendEntries(state, entries, rejections)
    for (const step of walked.steps) {
      if (step.kind === "batch") positions.set(step.batch.seq, { kind: "batch", batch: step.batch })
      else positions.set(step.seq, step.kind === "keyring" ? { kind: "keyring" } : { kind: "vetoed" })
    }
    for (const entry of entries) {
      if (entry.seq <= (walked.state.head?.seq ?? 0)) links.set(entry.seq, entry.link)
    }
    state = walked.state
    if (!walked.ok) {
      positions.set(walked.seq, { kind: "refused", reason: walked.reason })
      refusedAt = walked.seq
    }
  }

  const reach = async (seq: number): Promise<ChainPosition> => {
    if (refusedAt === null && (state.head?.seq ?? 0) < seq) await extend()
    const known = positions.get(seq)
    if (known !== undefined) return known
    if (refusedAt !== null && seq > refusedAt) return positions.get(refusedAt) ?? { kind: "unknown" }
    return { kind: "unknown" }
  }

  const epochKey = async (epoch: number): Promise<Uint8Array<ArrayBuffer> | null> => {
    const authority = state.authority
    if (authority === null) return null
    if (keysEpoch !== authority.epoch) {
      const wrap = committedWrap(state, authority.epoch, `device:${keyring.principal().id}`)
      const material = wrap === null ? null : await ownMaterial(keyring, account, wrap, expectedHistory(authority, authority.epoch))
      if (material === null) return null
      keys.clear()
      keys.set(material.epoch, new Uint8Array(material.current))
      for (const older of material.history) keys.set(older.epoch, new Uint8Array(older.key))
      keysEpoch = authority.epoch
    }
    return keys.get(epoch) ?? null
  }

  await extend()
  return {
    account,
    state: () => state,
    reach,
    linkAt: (seq) => links.get(seq) ?? null,
    epochKey,
    isMember: () => state.authority?.members.has(keyring.principal().id) === true,
  }
}
