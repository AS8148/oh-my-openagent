// The receive half, outside the writer lock (sync-design §5-§6): pull after the applied cursor in
// pages, download each object, check its SHA-256 against the entry, verify it, and journal it as
// `verified`. An entry this device already holds is a no-op when its (seq, batch id, digest)
// match and tampering when anything differs. The first refusal stops the pull: nothing after it
// is verified, so entries are applied strictly in order.

import { createHash } from "node:crypto"

import type { EngineDeps } from "./engine-deps"
import { toBase64, type IncomingRecord, type SyncJournal } from "./journal"
import type { PulledEntry, Verdict } from "./ports"

const PAGE = 100

export interface Received {
  readonly refused: number
  readonly snapshot: number | null
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

export async function receive(deps: EngineDeps, journal: SyncJournal): Promise<Received> {
  const state = await journal.state()
  const index = await journal.applied()
  const held = new Map((await journal.incoming()).map((r) => [r.entry.seq, r]))
  const heldBatches = new Map([...held.values()].map((r) => [r.entry.batchId, r.entry]))
  let expected = state.applied + 1
  let after = state.applied
  let snapshot: number | null = null
  const refusal = async (entry: PulledEntry, reason: string): Promise<Received> => {
    deps.log?.(`sync.batch.rejected seq=${entry.seq} batch=${entry.batchId}: ${reason}`)
    await journal.updateState({ refused: (await journal.state()).refused + 1 })
    return { refused: 1, snapshot }
  }
  const take = async (entry: PulledEntry, verify: (bytes: Uint8Array) => Promise<Verdict>, isSnapshot: boolean) => {
    const bytes = await deps.transport.download(entry.objectId)
    if (sha256Hex(bytes) !== entry.digest) return "content hash"
    await journal.putIncoming({ entry, stage: "downloaded", items: [], snapshot: isSnapshot })
    deps.fault?.("downloaded")
    const verdict = await verify(bytes)
    if (!verdict.ok) return verdict.reason
    const items = verdict.payload.items.map((i) => ({ key: i.key, ops: toBase64(i.ops) }))
    await journal.putIncoming({ entry, stage: "verified", items, snapshot: isSnapshot } satisfies IncomingRecord)
    deps.fault?.("verified")
    return null
  }
  for (;;) {
    const page = await deps.transport.pull(after, PAGE)
    if (page.snapshot !== null && page.snapshot.coversSeq >= expected) {
      const s = page.snapshot
      const entry: PulledEntry = { seq: s.coversSeq, batchId: `snapshot:${s.coversSeq}`, digest: s.digest, objectId: s.objectId, author: "snapshot" }
      if (held.get(s.coversSeq)?.stage !== "verified") {
        const problem = await take(entry, (bytes) => deps.verifier.verifySnapshot(s, bytes), true)
        if (problem !== null) return refusal(entry, problem)
      }
      snapshot = s.coversSeq
      expected = s.coversSeq + 1
    }
    for (const entry of page.entries) {
      const known = index[entry.batchId] ?? heldBatches.get(entry.batchId)
      if (entry.seq < expected) {
        const original = known ?? held.get(entry.seq)?.entry
        if (original !== undefined && (original.seq !== entry.seq || original.digest !== entry.digest)) {
          return refusal(entry, "an applied (seq, batch id) arrived with different content")
        }
        continue
      }
      if (entry.seq !== expected) return refusal(entry, `expected seq ${expected}`)
      if (known !== undefined && known.seq !== entry.seq) return refusal(entry, "a batch id already applied at another seq")
      const mine = held.get(entry.seq)
      if (mine?.stage !== "verified" || mine.entry.digest !== entry.digest) {
        const problem = await take(entry, (bytes) => deps.verifier.verifyEntry(entry, bytes), false)
        if (problem !== null) return refusal(entry, problem)
      }
      expected = entry.seq + 1
    }
    const last = page.entries.at(-1)
    if (!page.more || last === undefined) return { refused: 0, snapshot }
    after = last.seq
  }
}
