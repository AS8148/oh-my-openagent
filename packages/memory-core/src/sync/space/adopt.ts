// Insert-only adoption (sync-design §3): text with no shared CRDT history joins a space
// without losing a character. Only insertions are applied; nothing is deleted. A file
// identical to the device's last materialised text is skipped (the space state is taken,
// and a tombstoned item's file is removed, never revived). A changed file is adopted, and
// over a tombstone that adoption counts as an edit concurrent with the delete, so the item
// stays. Case-fold collisions and T1 side files land in the same item; T2 blocks are
// folded per key into the frontmatter. The result is the working text a §5 capture should
// apply; committing it is the caller's captureItem import.

import { splitItem, type FmValue } from "../item/frontmatter"

import { adoptFrontmatter, renderAssembled } from "./adopt-frontmatter"
import { parseSyncConflictName, stripT2Blocks } from "./hub-trace"
import { isOrderedSubsequence, mergeInsertions } from "./merge"

export interface Snapshot {
  readonly path: string
  readonly text: string
}

export interface ItemState {
  /** Content render of the space's item at the frontier this device materialised; null when absent. */
  readonly currentText: string | null
  readonly tombstoned: boolean
  /** The exact text this device last materialised for the item; null when it never did. */
  readonly lastMaterialised: string | null
}

export type AdoptionPlan =
  | { readonly action: "none"; readonly removeAfterCommit: readonly string[] }
  | { readonly action: "remove"; readonly removeAfterCommit: readonly string[] }
  | { readonly action: "capture"; readonly workingText: string; readonly removeAfterCommit: readonly string[] }

export function planAdoption(files: readonly Snapshot[], item: ItemState): AdoptionPlan {
  const mains: Snapshot[] = []
  const sides: Snapshot[] = []
  for (const file of files) {
    if (parseSyncConflictName(file.path) === null) mains.push(file)
    else sides.push(file)
  }
  const removeAfterCommit = sides.map((s) => s.path)
  const first = mains[0]
  const unchanged =
    item.lastMaterialised !== null &&
    sides.length === 0 &&
    mains.length === 1 &&
    first !== undefined &&
    first.text === item.lastMaterialised
  if (unchanged) {
    return item.tombstoned ? { action: "remove", removeAfterCommit } : { action: "none", removeAfterCommit }
  }
  const base = item.currentText ?? ""
  const fm = new Map<string, FmValue>()
  let body = ""
  const adoptFile = (text: string): void => {
    const parsed = splitItem(text)
    const conflicts = adoptFrontmatter(fm, parsed.fm ?? [])
    const stripped = stripT2Blocks(parsed.body)
    conflicts.push(...adoptFrontmatter(fm, stripped.entries))
    // A pure body deletion contributes no novel characters; adoption cannot delete.
    if (!isOrderedSubsequence(stripped.body, body)) body = mergeInsertions(body, stripped.body)
    for (const conflict of conflicts) {
      if (!body.split(/(?<=\n)/).includes(conflict)) {
        if (body !== "" && !body.endsWith("\n")) body += "\n"
        body += conflict
      }
    }
  }
  adoptFile(base)
  for (const file of mains) adoptFile(file.text)
  for (const file of sides) adoptFile(file.text)
  const rendered = renderAssembled([...fm.entries()].map(([key, value]) => ({ key, value })), body)
  if (rendered === base) {
    return item.tombstoned ? { action: "remove", removeAfterCommit } : { action: "none", removeAfterCommit }
  }
  return { action: "capture", workingText: rendered, removeAfterCommit }
}
