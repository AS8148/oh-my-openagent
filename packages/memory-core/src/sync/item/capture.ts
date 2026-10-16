// captureItem (sync-design §5): the working tree is diffed against the item's state at
// an explicit baseline frontier, on a throwaway fork at that frontier, so a stale writer's
// diff can only touch text it actually saw. That diff is merged into a throwaway copy of
// the CURRENT document and the result is transplanted onto the current document under the
// doc's own peer (review r3): every op this device ever exports carries its one stable
// peer, so the version vector stays one entry per device, and the ops continue that peer's
// counters instead of colliding with its later ops at the stale baseline (review r1 #1).
// Returns null when nothing changed. Replay safety lives one level up, in captureOnDevice
// (device-capture.ts), which is the only exported capture entry point.

import type { LoroDoc } from "../../crdt/loro-runtime"

import type { ItemFrontier } from "./document"
import type { FmValue } from "./frontmatter"
import { renderScalar, splitItem } from "./frontmatter"
import type { ItemHistory } from "./history"
import { analyzeHistory } from "./history"
import { renderDocContent } from "./render"
import type { KeyState } from "./state"
import { activeReg, combineKey, fmName, orderedSetElements, readKeyState, regText } from "./state"
import { newTag } from "./tag"
import { transplantContent } from "./transplant"

export class CaptureBaselineError extends Error {
  override readonly name = "CaptureBaselineError"
}

export function captureItem(
  doc: LoroDoc,
  baseText: string,
  baseFrontier: ItemFrontier,
  workingText: string,
): Uint8Array | null {
  const current = isCurrentFrontier(doc, baseFrontier)
  const merged = current ? null : mergeOntoCurrent(doc, baseText, baseFrontier, workingText)
  if (!current && merged === null) return null
  const target = doc.fork()
  try {
    target.setPeerId(doc.peerId)
    target.setRecordTimestamp(false)
    if (merged === null) {
      // Baseline is the current state: the diff applies directly, no rebase needed.
      if (renderDocContent(target) !== baseText) {
        throw new CaptureBaselineError("captureItem: baseText is not the item's render at baseFrontier")
      }
      applyWorkingText(target, workingText)
    } else {
      transplantContent(target, merged)
    }
    target.commit()
    const from = doc.oplogVersion()
    if (target.oplogVersion().compare(from) === 0) return null
    return target.export({ mode: "update", from })
  } finally {
    target.free()
    merged?.free()
  }
}

function isCurrentFrontier(doc: LoroDoc, frontier: ItemFrontier): boolean {
  const now = doc.frontiers()
  if (now.length !== frontier.length) return false
  return now.every((id) => frontier.some((f) => f.peer === id.peer && f.counter === id.counter))
}

/** The current document with the user's baseline-to-working diff merged in, under throwaway peers; null when the diff is empty. */
function mergeOntoCurrent(
  doc: LoroDoc,
  baseText: string,
  baseFrontier: ItemFrontier,
  workingText: string,
): LoroDoc | null {
  const scratch = doc.forkAt(baseFrontier)
  try {
    scratch.setRecordTimestamp(false)
    if (renderDocContent(scratch) !== baseText) {
      throw new CaptureBaselineError("captureItem: baseText is not the item's render at baseFrontier")
    }
    applyWorkingText(scratch, workingText)
    scratch.commit()
    const from = scratch.frontiersToVV(baseFrontier)
    if (scratch.oplogVersion().compare(from) === 0) return null
    const merged = doc.fork()
    merged.setRecordTimestamp(false)
    merged.import(scratch.export({ mode: "update", from }))
    return merged
  } finally {
    scratch.free()
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
    // The text join is bare text; a re-parsed register/set value arrives renderScalar-quoted,
    // so compare the bare form (review r2 #2). A stale writer whose text already lost to a
    // concurrent register must not re-install it (review r2 #3): when the key has no text
    // content yet but a register does, the register wins and the text is folded in, not set.
    const combinedText = combined?.kind === "text" ? combined.text : undefined
    if (combinedText !== undefined && (combinedText === target || combinedText === regText(target))) return
    const regWon = (state.text === null || state.text === "") && activeReg(state.reg).length > 0
    if (!regWon && state.text !== target) fork.getText(fmName(key, "text")).update(target)
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
  }  const target = toRegister(value)
  const combinedReg = combined?.kind === "reg" ? combined.text : undefined
  // A re-parsed text scalar that equals the current join is a no-op even when renderScalar
  // quoted it ("q: r / true" parses back as bare text); compare the dequoted forms.
  if (combinedReg !== undefined && (combinedReg === target || combinedReg === regText(target))) return
  const active = activeReg(state.reg)
  // A no-op only when every active entry already holds the target (duplicates of one value).
  // When other values are active, the user is resolving a conflict by hand: write an entry
  // that supersedes all of them, or the conflict re-renders over the user's choice (r2 HIGH-2).
  if (active.length > 0 && active.every((e) => e.value === target)) return
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

