// History walk over the oplog (sync-design §2): the kind of a frontmatter key and the
// on-disk order of keys and set elements are decided by the EARLIEST operation that
// wrote them, in (Lamport, peer) order. That order lives only in the oplog - an op
// cannot carry its own Lamport stamp - so it is derived here, identically on every
// peer that holds the same history. No timestamp or peer order ever decides content.

import type { LoroDoc, PeerID } from "loro-crdt"

export type FmPart = "text" | "set" | "reg"

export interface Stamp {
  readonly lamport: number
  readonly peer: PeerID
}

export interface KeyHistory {
  readonly kind: FmPart
  readonly first: Stamp
  readonly byKind: ReadonlyMap<FmPart, Stamp>
}

export interface ItemHistory {
  readonly keys: ReadonlyMap<string, KeyHistory>
  readonly setAdds: ReadonlyMap<string, ReadonlyMap<string, Stamp>>
  readonly regAdds: ReadonlyMap<string, ReadonlyMap<string, Stamp>>
}

interface OpLike {
  readonly container: string
  readonly counter: number
  readonly content: unknown
}

const cache = new WeakMap<LoroDoc, { readonly changeCount: number; readonly value: ItemHistory }>()

export function analyzeHistory(doc: LoroDoc): ItemHistory {
  const changeCount = doc.changeCount()
  const hit = cache.get(doc)
  if (hit !== undefined && hit.changeCount === changeCount) return hit.value

  const keys = new Map<string, { kind: FmPart; first: Stamp; byKind: Map<FmPart, Stamp> }>()
  const setAdds = new Map<string, Map<string, Stamp>>()
  const regAdds = new Map<string, Map<string, Stamp>>()
  const changes = [...doc.getAllChanges().values()].flat()
  changes.sort((a, b) => a.lamport - b.lamport || peerCompare(a.peer, b.peer))
  for (const change of changes) {
    for (const op of readOps(doc, { peer: change.peer, counter: change.counter })) {
      const parsed = parseFmContainer(op.container)
      if (parsed === null) continue
      const stamp: Stamp = { lamport: change.lamport + (op.counter - change.counter), peer: change.peer }
      const existing = keys.get(parsed.key)
      if (existing === undefined) {
        keys.set(parsed.key, { kind: parsed.part, first: stamp, byKind: new Map([[parsed.part, stamp]]) })
      } else if (!existing.byKind.has(parsed.part)) {
        existing.byKind.set(parsed.part, stamp)
      }
      if (parsed.part !== "text") {
        const tag = mapInsertKey(op.content)
        if (tag !== null) {
          const book = parsed.part === "set" ? setAdds : regAdds
          const perKey = book.get(parsed.key) ?? new Map<string, Stamp>()
          if (!perKey.has(tag)) perKey.set(tag, stamp)
          book.set(parsed.key, perKey)
        }
      }
    }
  }

  const value: ItemHistory = { keys, setAdds, regAdds }
  cache.set(doc, { changeCount, value })
  return value
}

function peerCompare(a: PeerID, b: PeerID): number {
  const pa = BigInt(a)
  const pb = BigInt(b)
  return pa < pb ? -1 : pa > pb ? 1 : 0
}

function readOps(doc: LoroDoc, id: { peer: PeerID; counter: number }): readonly OpLike[] {
  const ops: unknown = doc.getOpsInChange(id)
  if (!Array.isArray(ops)) return []
  const out: OpLike[] = []
  for (const raw of ops) {
    if (typeof raw !== "object" || raw === null) continue
    if (!("container" in raw) || !("counter" in raw)) continue
    const { container, counter } = raw
    if (typeof container !== "string" || typeof counter !== "number") continue
    out.push({ container, counter, content: "content" in raw ? raw.content : undefined })
  }
  out.sort((a, b) => a.counter - b.counter)
  return out
}

function mapInsertKey(content: unknown): string | null {
  if (typeof content !== "object" || content === null) return null
  if (!("type" in content) || content.type !== "insert") return null
  if (!("key" in content) || typeof content.key !== "string") return null
  return content.key
}

const FM_PREFIX = "cid:root-"
const SEP = "\x1f"

function parseFmContainer(container: string): { readonly key: string; readonly part: FmPart } | null {
  if (!container.startsWith(`${FM_PREFIX}fm${SEP}`)) return null
  const colon = container.lastIndexOf(":")
  if (colon < FM_PREFIX.length) return null
  const name = container.slice(FM_PREFIX.length, colon)
  const segments = name.split(SEP)
  const part = segments[2]
  if (segments.length !== 3 || (part !== "text" && part !== "set" && part !== "reg")) return null
  try {
    return { key: decodeURIComponent(segments[1] ?? ""), part }
  } catch {
    return null
  }
}
