// Stand-ins for the todo 13 crypto: sealing is plain JSON that names its batch id and base, and
// the verifier refuses what a real one would - an object naming another batch, another account,
// or any seq the test marks as failing a receiver check.

import type { BatchPayload, PulledEntry, Sealer, SnapshotRef, Verdict, Verifier } from "./ports"

interface Sealed {
  readonly account: string
  readonly batchId: string
  readonly baseSeq: number
  readonly items: readonly { readonly key: string; readonly ops: string }[]
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function encodePayload(account: string, batchId: string, baseSeq: number, payload: BatchPayload): Uint8Array {
  const sealed: Sealed = {
    account,
    batchId,
    baseSeq,
    items: payload.items.map((i) => ({ key: i.key, ops: Buffer.from(i.ops).toString("base64") })),
  }
  return encoder.encode(JSON.stringify(sealed))
}

export class FakeSealer implements Sealer {
  constructor(private readonly account: string) {}

  async seal(batchId: string, baseSeq: number, payload: BatchPayload): Promise<Uint8Array> {
    return encodePayload(this.account, batchId, baseSeq, payload)
  }
}

export class FakeVerifier implements Verifier {
  /** seq -> the receiver check it fails (signature, link, epoch, ...). */
  readonly failing = new Map<number, string>()
  readonly refusals: string[] = []

  constructor(private readonly account: string) {}

  async verifyEntry(entry: PulledEntry, bytes: Uint8Array): Promise<Verdict> {
    const forced = this.failing.get(entry.seq)
    if (forced !== undefined) return this.refuse(forced)
    const sealed = this.open(bytes)
    if (sealed === null) return this.refuse("malformed object")
    if (sealed.account !== this.account) return this.refuse("account binding")
    if (sealed.batchId !== entry.batchId) return this.refuse("object binding")
    return { ok: true, payload: payloadOf(sealed) }
  }

  async verifySnapshot(_snapshot: SnapshotRef, bytes: Uint8Array): Promise<Verdict> {
    const sealed = this.open(bytes)
    if (sealed === null) return this.refuse("malformed snapshot")
    if (sealed.account !== this.account) return this.refuse("account binding")
    return { ok: true, payload: payloadOf(sealed) }
  }

  private refuse(reason: string): Verdict {
    this.refusals.push(reason)
    return { ok: false, reason }
  }

  private open(bytes: Uint8Array): Sealed | null {
    try {
      return JSON.parse(decoder.decode(bytes)) as Sealed
    } catch {
      return null
    }
  }
}

function payloadOf(sealed: Sealed): BatchPayload {
  return { items: sealed.items.map((i) => ({ key: i.key, ops: new Uint8Array(Buffer.from(i.ops, "base64")) })) }
}
