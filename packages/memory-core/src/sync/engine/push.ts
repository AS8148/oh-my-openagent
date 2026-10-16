// The push half, outside the writer lock (sync-design §6): seal the journaled pending ops as one
// batch on the applied cursor, reserve, upload, append. Each step is journaled before the next, and
// the batch id is the append's idempotency key, so a crash after the server accepted the batch
// re-sends the same id and gets the original seq back instead of a second entry.

import { createHash, randomBytes } from "node:crypto"

import type { EngineDeps } from "./engine-deps"
import { fromBase64, type OutgoingBatch, type SyncJournal, toBase64, type WireItem } from "./journal"

export type PushOutcome = "idle" | "pushed" | "stale"

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")
const carried = (out: OutgoingBatch, item: WireItem): boolean => out.items.some((o) => o.key === item.key && o.ops === item.ops)

async function seal(deps: EngineDeps, journal: SyncJournal, items: readonly WireItem[], batchId: string): Promise<OutgoingBatch> {
  const baseSeq = (await journal.state()).applied
  const payload = { items: items.map((i) => ({ key: i.key, ops: fromBase64(i.ops) })) }
  const bytes = await deps.sealer.seal(batchId, baseSeq, payload)
  const out: OutgoingBatch = { batchId, baseSeq, digest: sha256Hex(bytes), bytes: toBase64(bytes), uploadId: null, stage: "sealed", items }
  await journal.setPending({ items, outgoing: out })
  deps.fault?.("sealed")
  return out
}

export async function push(deps: EngineDeps, journal: SyncJournal): Promise<PushOutcome> {
  const pending = await journal.pending()
  let out = pending.outgoing
  if (out === null) {
    if (pending.items.length === 0) return "idle"
    out = await seal(deps, journal, pending.items, randomBytes(12).toString("hex"))
  }
  const bytes = fromBase64(out.bytes)
  if (out.stage === "sealed") {
    out = { ...out, uploadId: await deps.transport.reserve(bytes.length, out.digest), stage: "reserved" }
    await journal.setPending({ ...pending, outgoing: out })
    deps.fault?.("reserved")
  }
  if (out.stage === "reserved") {
    await deps.transport.upload(out.uploadId ?? "", bytes)
    out = { ...out, stage: "uploaded" }
    await journal.setPending({ ...pending, outgoing: out })
    deps.fault?.("uploaded")
  }
  const result = await deps.transport.append({ uploadId: out.uploadId ?? "", digest: out.digest, baseSeq: out.baseSeq, batchId: out.batchId })
  if (!result.ok) {
    await journal.setPending({ items: (await journal.pending()).items, outgoing: null })
    return "stale"
  }
  deps.fault?.("append-landed")
  const sent = out
  await journal.recordApplied([{ seq: result.seq, batchId: sent.batchId, digest: sent.digest, objectId: "", author: "self" }])
  const state = await journal.state()
  if (result.seq === state.applied + 1) await journal.updateState({ applied: result.seq })
  const remaining = (await journal.pending()).items.filter((i) => !carried(sent, i))
  await journal.setPending({ items: remaining, outgoing: null })
  deps.fault?.("appended")
  return "pushed"
}
