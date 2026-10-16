// The apply journal in `<gitDir>/omo-sync/` (sync-design §5). Incoming batches move
// downloaded -> verified on their own record; the cycle that applies them moves
// merged -> rendered -> committed -> checkpointed as one unit and lists the batches it covers.
// The applied cursor moves only at `checkpointed`; the event cursor (newest advertised head) is
// kept apart and never decides what is pulled. Outgoing ops are journaled as `pending` the moment
// they are captured, before anything is rendered.

import { randomBytes } from "node:crypto"

import { readdir, rename } from "../../fs/resilient"
import { join } from "node:path"

import { readJson, removeAtomic, TEMP_MARK, writeJson } from "./atomic"
import type { PulledEntry, RefusalCode } from "./ports"

export type IncomingStage = "downloaded" | "verified"
export type CycleStage = "merged" | "rendered" | "committed" | "checkpointed"

export interface WireItem {
  readonly key: string
  /** base64 of the item's CRDT update */
  readonly ops: string
}

export interface IncomingRecord {
  readonly entry: PulledEntry
  readonly stage: IncomingStage
  readonly items: readonly WireItem[]
  readonly snapshot: boolean
}

export interface CycleRecord {
  readonly id: string
  readonly stage: CycleStage
  readonly first: number
  readonly last: number
  readonly batches: readonly PulledEntry[]
  readonly keys: readonly string[]
  /** Rendered text per touched item; null removes the file. */
  readonly texts: Readonly<Record<string, string | null>>
  readonly treeId: string | null
}

export interface EngineState {
  /** The newest seq verified, applied and checkpointed on this device. */
  readonly applied: number
  /** The newest head the event stream advertised; a trigger only. */
  readonly eventHead: number
  readonly refused: number
  readonly cycle: CycleRecord | null
  /** The entry the pull stopped at; cleared once a later pull verifies past it. */
  readonly paused: { readonly seq: number; readonly code: RefusalCode } | null
  readonly lastSyncedAt: number | null
  /** Memories the last refusal-free cycle updated on this device. */
  readonly updatedWhileOffline: number
  /** The device peer this journal was created under. */
  readonly peer: string | null
}

export interface OutgoingBatch {
  readonly batchId: string
  readonly baseSeq: number
  readonly digest: string
  readonly bytes: string
  readonly uploadId: string | null
  readonly epoch: number
  readonly link: string
  readonly recordSig: string
  readonly stage: "sealed" | "reserved" | "uploaded"
  readonly items: readonly WireItem[]
}

export interface PendingOps {
  readonly items: readonly WireItem[]
  readonly outgoing: OutgoingBatch | null
}

const EMPTY_STATE: EngineState = {
  applied: 0,
  eventHead: 0,
  refused: 0,
  cycle: null,
  paused: null,
  lastSyncedAt: null,
  updatedWhileOffline: 0,
  peer: null,
}
const EMPTY_PENDING: PendingOps = { items: [], outgoing: null }

export class SyncJournal {
  readonly dir: string
  readonly tmpDir: string

  constructor(gitDir: string) {
    this.dir = join(gitDir, "omo-sync")
    this.tmpDir = join(this.dir, "tmp")
  }

  state(): Promise<EngineState> {
    return readJson(join(this.dir, "state.json"), EMPTY_STATE)
  }

  async updateState(patch: Partial<EngineState>): Promise<EngineState> {
    const next = { ...(await this.state()), ...patch }
    await writeJson(join(this.dir, "state.json"), next)
    return next
  }

  /** Moves the whole journal aside (another device's, carried by a copied repo); a fresh one starts empty. */
  async retire(): Promise<void> {
    try {
      await rename(this.dir, `${this.dir}.retired-${Date.now()}-${randomBytes(4).toString("hex")}`)
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    }
  }

  putIncoming(record: IncomingRecord): Promise<void> {
    return writeJson(this.incomingPath(record.entry.seq), record)
  }

  async incoming(): Promise<IncomingRecord[]> {
    const dir = join(this.dir, "incoming")
    const names = await readdir(dir).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [] as string[]
      throw error
    })
    const records: IncomingRecord[] = []
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith(TEMP_MARK)) continue
      records.push(await readJson<IncomingRecord>(join(dir, name), null as never))
    }
    return records.sort((a, b) => a.entry.seq - b.entry.seq)
  }

  dropIncoming(seq: number): Promise<void> {
    return removeAtomic(this.incomingPath(seq))
  }

  /** Applied batch ids with the seq and digest they were applied at (at-most-once apply). */
  applied(): Promise<Record<string, { readonly seq: number; readonly digest: string }>> {
    return readJson(join(this.dir, "applied.json"), {})
  }

  async recordApplied(entries: readonly PulledEntry[]): Promise<void> {
    const index = { ...(await this.applied()) }
    for (const e of entries) if (e.batchId !== null) index[e.batchId] = { seq: e.seq, digest: e.digest }
    await writeJson(join(this.dir, "applied.json"), index)
  }

  pending(): Promise<PendingOps> {
    return readJson(join(this.dir, "pending.json"), EMPTY_PENDING)
  }

  setPending(pending: PendingOps): Promise<void> {
    return writeJson(join(this.dir, "pending.json"), pending)
  }

  private incomingPath(seq: number): string {
    return join(this.dir, "incoming", `${String(seq).padStart(12, "0")}.json`)
  }
}

export const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64")
export const fromBase64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64"))
