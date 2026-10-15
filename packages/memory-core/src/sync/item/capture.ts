// captureItem (sync-design §5): the working tree is diffed against the item's state at
// an explicit baseline frontier. The ops are generated on a FORK at that frontier, so a
// stale writer's diff can only touch text it actually saw; importing the update into the
// store doc merges it with anything newer. Returns null when nothing changed.

import type { LoroDoc } from "loro-crdt"

import type { ItemFrontier } from "./document"
import type { FmValue } from "./frontmatter"
import { renderScalar, splitItem } from "./frontmatter"
import type { ItemHistory } from "./history"
import { analyzeHistory } from "./history"
import { renderDocContent } from "./render"
import type { KeyState } from "./state"
import { activeReg, combineKey, fmName, orderedSetElements, readKeyState } from "./state"

export class CaptureBaselineError extends Error {
  override readonly name = "CaptureBaselineError"
}

export function captureItem(
  doc: LoroDoc,
  baseText: string,
  baseFrontier: ItemFrontier,
  workingText: string,
): Uint8Array | null {
  const fork = doc.forkAt(baseFrontier)
  try {
    fork.setPeerId(doc.peerIdStr)
    fork.setRecordTimestamp(false)
    if (renderDocContent(fork) !== baseText) {
      throw new CaptureBaselineError("captureItem: baseText is not the item's render at baseFrontier")
    }
    applyWorkingText(fork, workingText)
    fork.commit()
    const from = fork.frontiersToVV(baseFrontier)
    if (fork.oplogVersion().compare(from) === 0) return null
    return fork.export({ mode: "update", from })
  } finally {
    fork.free()
  }
}

function applyWorkingText(fork: LoroDoc, workingText: string): void {
  const parsed = splitItem(workingText)
  const history = analyzeHistory(fork)
  const wanted = new Map<string, FmValue>()
  if (parsed.fm !== null) for (const entry of parsed.fm) wanted.set(entry.key, entry.value)
  for (const key of history.keys.keys()) {
    const value = wanted.get(key)
    if (value === undefined || value.kind === "remove") clearKey(fork, key)
  }
  if (parsed.fm !== null) {
    for (const { key, value } of parsed.fm) {
      if (value.kind !== "remove") applyKey(fork, key, value, history)
    }
  }
  const bodyTarget = parsed.fm === null ? workingText : parsed.body
  const bodyCurrent = fork.hasContainer("cid:root-body:Text") ? fork.getText("body").toString() : ""
  if (bodyCurrent !== bodyTarget) fork.getText("body").update(bodyTarget)
}

function applyKey(fork: LoroDoc, key: string, value: FmValue, history: ItemHistory): void {
  const kh = history.keys.get(key)
  if (kh === undefined) {
    writeNatural(fork, key, value)
    return
  }
  const state = readKeyState(fork, key)
  const combined = combineKey(state, key, kh, history)
  if (kh.kind === "text") {
    const target = toText(value)
    if (combined?.kind === "text" && combined.text === renderScalar(target)) return
    if (state.text !== target) fork.getText(fmName(key, "text")).update(target)
    clearLosers(fork, key, state, "text")
    return
  }
  if (kh.kind === "set") {
    const target = toElements(value)
    const current = combined?.kind === "set" ? combined.elements : orderedSetElements(state, key, history)
    if (sameList(current, target)) return
    syncSet(fork, key, state, target)
    clearLosers(fork, key, state, "set")
    return
  }
  const target = toRegister(value)
  if (combined?.kind === "reg" && combined.text === target) return
  const active = activeReg(state.reg)
  const entry = { v: target, s: active.map((e) => e.tag) }
  fork.getMap(fmName(key, "reg")).set(newTag(fork, target), entry)
  clearLosers(fork, key, state, "reg")
}

function writeNatural(fork: LoroDoc, key: string, value: FmValue): void {
  if (value.kind === "text") {
    if (value.text !== "") fork.getText(fmName(key, "text")).update(value.text)
    return
  }
  if (value.kind === "set") {
    const map = fork.getMap(fmName(key, "set"))
    for (const element of value.elements) map.set(newTag(fork, element), element)
    return
  }
  if (value.kind === "reg") {
    fork.getMap(fmName(key, "reg")).set(newTag(fork, value.value), { v: value.value, s: [] })
  }
}

function clearKey(fork: LoroDoc, key: string): void {
  const state = readKeyState(fork, key)
  if (state.text !== null && state.text !== "") {
    fork.getText(fmName(key, "text")).delete(0, state.text.length)
  }
  if (state.set.length > 0) {
    const map = fork.getMap(fmName(key, "set"))
    for (const { tag } of state.set) map.delete(tag)
  }
  supersedeRegister(fork, key, state)
}

function clearLosers(fork: LoroDoc, key: string, state: KeyState, winner: "text" | "set" | "reg"): void {
  if (winner !== "text" && state.text !== null && state.text !== "") {
    fork.getText(fmName(key, "text")).delete(0, state.text.length)
  }
  if (winner !== "set" && state.set.length > 0) {
    const map = fork.getMap(fmName(key, "set"))
    for (const { tag } of state.set) map.delete(tag)
  }
  if (winner !== "reg") supersedeRegister(fork, key, state)
}

function supersedeRegister(fork: LoroDoc, key: string, state: KeyState): void {
  const active = activeReg(state.reg)
  if (active.length === 0) return
  const entry = { v: null, s: active.map((e) => e.tag) }
  fork.getMap(fmName(key, "reg")).set(newTag(fork, "null"), entry)
}

function syncSet(fork: LoroDoc, key: string, state: KeyState, target: readonly string[]): void {
  const wanted = new Set(target)
  const present = new Map<string, string>()
  for (const { tag, element } of state.set) if (!present.has(element)) present.set(element, tag)
  const map = fork.getMap(fmName(key, "set"))
  for (const { tag, element } of state.set) if (!wanted.has(element)) map.delete(tag)
  for (const element of target) if (!present.has(element)) map.set(newTag(fork, element), element)
}

function toText(value: FmValue): string {
  if (value.kind === "text") return value.text
  if (value.kind === "set") return value.flow
  if (value.kind === "reg") return value.value
  return ""
}

function toElements(value: FmValue): readonly string[] {
  if (value.kind === "set") return value.elements
  if (value.kind === "text") return [renderScalar(value.text)]
  if (value.kind === "reg") return [value.value]
  return []
}

function toRegister(value: FmValue): string {
  if (value.kind === "reg") return value.value
  if (value.kind === "text") return renderScalar(value.text)
  if (value.kind === "set") return value.flow
  return ""
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function newTag(fork: LoroDoc, salt: string): string {
  return `${fork.peerIdStr}@${fork.opCount()}#${fnv1a(salt, 2166136261)}${fnv1a(salt, 424242)}`
}

function fnv1a(text: string, basis: number): string {
  let hash = basis
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}
