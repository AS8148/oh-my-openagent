// The deletion gate on the COMMITTED item (sync-design #454 §3, review r7 H1). The plan's
// removalCandidates are only candidates: a source is removed after the adoption's single update
// is imported, and only when the read-back against the doc's own render and active register
// entries finds every one of its lines. A candidate the doc does not fully hold stays on disk
// with its reason; the planner's prediction never vouches for itself.

import type { LoroDoc } from "../../crdt/loro-runtime"
import { activeRegisters } from "../item/index"
import { renderDocContent } from "../item/render"

import type { AdoptionPlan, RetainedSource, Snapshot } from "./adopt"
import { firstMissingFact, normalizeInput } from "./read-back"

export interface RemovalDecision {
  readonly remove: readonly string[]
  readonly retained: readonly RetainedSource[]
}

export function confirmRemovals(doc: LoroDoc, plan: AdoptionPlan, files: readonly Snapshot[]): RemovalDecision {
  const committed = renderDocContent(doc)
  const registers = activeRegisters(doc)
  const remove: string[] = []
  const retained: RetainedSource[] = [...plan.retainedSources]
  for (const path of plan.removalCandidates) {
    const source = files.find((file) => file.path === path)
    const missing = source === undefined ? "source not among the adopted files" : firstMissingFact(committed, normalizeInput(source.text), registers)
    if (missing === null) remove.push(path)
    else retained.push({ path, reason: missing })
  }
  return { remove, retained }
}
