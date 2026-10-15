// Current per-key container contents and their combination under the kind rule
// (sync-design §2): a key's kind is fixed by its earliest first-write op, and content in
// containers of other kinds renders converted into that kind, losslessly. Both render.ts
// and capture.ts read state through here so capture's no-op detection compares against
// exactly what render would emit.

import type { ContainerID, ContainerType, LoroDoc } from "loro-crdt"

import { renderScalar } from "./frontmatter"
import type { FmPart, ItemHistory, KeyHistory, Stamp } from "./history"

export const BODY_NAME = "body"
export const TOMBSTONES_NAME = "tombstones"

export function fmName(key: string, part: FmPart): string {
  return `fm/${encodeURIComponent(key)}/${part}`
}

export function cidRoot(name: string, type: ContainerType): ContainerID {
  return `cid:root-${name}:${type}`
}

export interface RegEntry {
  readonly tag: string
  readonly value: string | null
  readonly supersedes: readonly string[]
}

export interface KeyState {
  readonly text: string | null
  readonly set: readonly { readonly tag: string; readonly element: string }[]
  readonly reg: readonly RegEntry[]
}

export function readKeyState(doc: LoroDoc, key: string): KeyState {
  const text = doc.hasContainer(cidRoot(fmName(key, "text"), "Text"))
    ? doc.getText(fmName(key, "text")).toString()
    : null
  const set: { tag: string; element: string }[] = []
  if (doc.hasContainer(cidRoot(fmName(key, "set"), "Map"))) {
    for (const [tag, value] of doc.getMap(fmName(key, "set")).entries()) {
      if (typeof value === "string") set.push({ tag, element: value })
    }
  }
  const reg: RegEntry[] = []
  if (doc.hasContainer(cidRoot(fmName(key, "reg"), "Map"))) {
    for (const [tag, value] of doc.getMap(fmName(key, "reg")).entries()) {
      const entry = asRegEntry(tag, value)
      if (entry !== null) reg.push(entry)
    }
  }
  return { text, set, reg }
}

function asRegEntry(tag: string, value: unknown): RegEntry | null {
  if (typeof value !== "object" || value === null) return null
  if (!("v" in value) || !("s" in value)) return null
  const v = value.v
  const s = value.s
  if (v !== null && typeof v !== "string") return null
  if (!Array.isArray(s) || s.some((t) => typeof t !== "string")) return null
  return { tag, value: v, supersedes: s as readonly string[] }
}

export function activeReg(entries: readonly RegEntry[]): (RegEntry & { readonly value: string })[] {
  const superseded = new Set(entries.flatMap((entry) => entry.supersedes))
  return entries.filter(
    (entry): entry is RegEntry & { readonly value: string } => entry.value !== null && !superseded.has(entry.tag),
  )
}

const MISSING_STAMP: Stamp = { lamport: Number.MAX_SAFE_INTEGER, peer: "0" }

function stampCompare(a: Stamp, b: Stamp): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport
  const pa = BigInt(a.peer)
  const pb = BigInt(b.peer)
  return pa < pb ? -1 : pa > pb ? 1 : 0
}

function addStamp(history: ItemHistory, key: string, part: "set" | "reg", tag: string, fallback: Stamp | undefined): Stamp {
  const book = part === "set" ? history.setAdds : history.regAdds
  return book.get(key)?.get(tag) ?? fallback ?? MISSING_STAMP
}

export function orderedSetElements(state: KeyState, key: string, history: ItemHistory): string[] {
  const fallback = history.keys.get(key)?.byKind.get("set")
  const tagged = state.set.map(({ tag, element }) => ({
    element,
    stamp: addStamp(history, key, "set", tag, fallback),
  }))
  tagged.sort((a, b) => stampCompare(a.stamp, b.stamp) || (a.element < b.element ? -1 : a.element > b.element ? 1 : 0))
  const seen = new Set<string>()
  const out: string[] = []
  for (const { element } of tagged) {
    if (seen.has(element)) continue
    seen.add(element)
    out.push(element)
  }
  return out
}

export type CombinedValue =
  | { readonly kind: "text" | "reg"; readonly text: string }
  | { readonly kind: "set"; readonly elements: readonly string[] }

export function combineKey(state: KeyState, key: string, kh: KeyHistory, history: ItemHistory): CombinedValue | null {
  const active = activeReg(state.reg)
  const regValues = [...active].sort((a, b) =>
    a.value === b.value ? (a.tag < b.tag ? -1 : 1) : a.value < b.value ? -1 : 1,
  )
  if (kh.kind === "text") {
    const parts: { readonly stamp: Stamp; readonly out: string }[] = []
    if (state.text !== null && state.text !== "") {
      parts.push({ stamp: kh.byKind.get("text") ?? MISSING_STAMP, out: renderScalar(state.text) })
    }
    const elements = orderedSetElements(state, key, history)
    if (elements.length > 0) {
      parts.push({ stamp: kh.byKind.get("set") ?? MISSING_STAMP, out: `[${elements.join(", ")}]` })
    }
    if (regValues.length > 0) {
      parts.push({ stamp: kh.byKind.get("reg") ?? MISSING_STAMP, out: regValues.map((e) => e.value).join(" / ") })
    }
    if (parts.length === 0) return null
    parts.sort((a, b) => stampCompare(a.stamp, b.stamp))
    return { kind: "text", text: parts.map((part) => part.out).join(" ") }
  }
  if (kh.kind === "set") {
    const tagged: { readonly stamp: Stamp; readonly source: string }[] = state.set.map(({ tag, element }) => ({
      source: element,
      stamp: addStamp(history, key, "set", tag, kh.byKind.get("set")),
    }))
    if (state.text !== null && state.text !== "") {
      tagged.push({ source: renderScalar(state.text), stamp: kh.byKind.get("text") ?? MISSING_STAMP })
    }
    for (const entry of active) {
      tagged.push({ source: entry.value, stamp: addStamp(history, key, "reg", entry.tag, kh.byKind.get("reg")) })
    }
    tagged.sort((a, b) => stampCompare(a.stamp, b.stamp) || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0))
    const seen = new Set<string>()
    const elements: string[] = []
    for (const { source } of tagged) {
      if (seen.has(source)) continue
      seen.add(source)
      elements.push(source)
    }
    if (elements.length === 0) return null
    return { kind: "set", elements }
  }
  const values = regValues.map((entry) => entry.value)
  if (state.text !== null && state.text !== "") values.push(renderScalar(state.text))
  for (const { element } of state.set) values.push(element)
  values.sort()
  if (values.length === 0) return null
  return { kind: "reg", text: values.join(" / ") }
}
