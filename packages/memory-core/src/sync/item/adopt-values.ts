// The item half of insert-only adoption (sync-design §3). Adoption cannot be pure text: a
// register value that differs from the space's active values joins as one more entry that
// supersedes nothing, and re-capturing the joined render would store ONE string instead.
// So the planner hands the extra values here, after the working text is captured.

import type { LoroDoc } from "../../crdt/loro-runtime"

import { analyzeHistory } from "./history"
import { addRegisterValue } from "./key-writers"
import { activeReg, readKeyState, registerValues } from "./state"

export interface RegisterValue {
  readonly key: string
  /** Canonical YAML source of the value, as the frontmatter parser classifies it. */
  readonly value: string
}

/**
 * One update holding `captured` (a capture's update, or null when the body and keys are unchanged)
 * plus every register value not already active (an entry superseding nothing), committed under
 * `commitMessage`. Internal to captureOnDevice (device-capture.ts), the only capture entry point:
 * adoption's capture and its register values land together and replay under the same receipts.
 */
export function withRegisterValues(doc: LoroDoc, captured: Uint8Array | null, values: readonly RegisterValue[], commitMessage?: string): Uint8Array | null {
  if (values.length === 0) return captured
  const target = doc.fork()
  try {
    target.setPeerId(doc.peerId)
    target.setRecordTimestamp(false)
    if (captured !== null) target.import(captured)
    values.forEach(({ key, value }, slot) => addRegisterValue(target, key, value, slot))
    target.commit(commitMessage === undefined ? undefined : { message: commitMessage })
    const from = doc.oplogVersion()
    if (target.oplogVersion().compare(from) === 0) return null
    return target.export({ mode: "update", from })
  } finally {
    target.free()
  }
}

/** True when every value is already an active entry of its register. */
export function registerValuesActive(doc: LoroDoc, values: readonly RegisterValue[]): boolean {
  return values.every(({ key, value }) => activeReg(readKeyState(doc, key).reg).some((entry) => entry.value === value))
}

/**
 * Every register key's rendered components: its active values plus any set content it renders
 * beside them (state.ts combineRegister). The planner's view of what the space already holds,
 * which a joined render alone cannot say exactly.
 */
export function activeRegisters(doc: LoroDoc): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [key, kh] of analyzeHistory(doc).keys) {
    if (kh.kind !== "reg") continue
    const state = readKeyState(doc, key)
    const parts = [...new Set([...registerValues(state.reg), ...state.set.map((entry) => entry.element)])]
    if (parts.length > 0) out.set(key, parts)
  }
  return out
}
