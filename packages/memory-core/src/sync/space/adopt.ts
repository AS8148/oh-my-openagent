// Insert-only adoption (sync-design §3): text with no shared CRDT history joins a space
// without losing a character. Only insertions are applied; nothing is deleted. A file
// identical to the device's last materialised text is skipped (the space state is taken,
// and a tombstoned item's file is removed, never revived). A changed file is adopted, and
// over a tombstone that adoption counts as an edit concurrent with the delete, so the item
// stays. Case-fold collisions and T1 side files land in the same item; T2 blocks are
// folded per key into the frontmatter. The result is the working text a §5 capture should
// apply; committing it is the caller's captureItem import.
//
// Every file is read as LF text (CRLF is normalised on input). The body shortcut is a
// provable local deletion only: it applies to a main file whose text is a character
// subsequence of what this device last materialised (an in-line word deletion included;
// adopting the shortened line as new text would duplicate the sentence). Side files and history-less mains
// are always line-merged. A source file enters removeAfterCommit only after the
// independent read-back (read-back.ts) proves every one of its facts survived: every body
// line as many times as the source has it, every frontmatter value merged or kept as a
// marked conflict. A source that fails the read-back stays on disk and the plan records
// its structured reason in retainedSources; deletion is never silent.

import { splitItem, type FmValue } from "../item/frontmatter"

import { adoptFrontmatter, renderAssembled } from "./adopt-frontmatter"
import { parseSyncConflictName, stripT2Blocks } from "./hub-trace"
import { isOrderedSubsequence, mergeInsertions } from "./merge"
import { firstMissingFact, toLf } from "./read-back"

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

export interface RetainedSource {
  readonly path: string
  /** Structured machine-readable reason the source was kept, e.g. the first missing fact. */
  readonly reason: string
}

export type AdoptionPlan =
  | { readonly action: "none"; readonly removeAfterCommit: readonly string[]; readonly retainedSources: readonly RetainedSource[] }
  | { readonly action: "remove"; readonly removeAfterCommit: readonly string[]; readonly retainedSources: readonly RetainedSource[] }
  | { readonly action: "capture"; readonly workingText: string; readonly removeAfterCommit: readonly string[]; readonly retainedSources: readonly RetainedSource[] }

export function planAdoption(
  files: readonly Snapshot[],
  item: ItemState,
  merge: (base: string, incoming: string) => string = mergeInsertions,
): AdoptionPlan {
  const mains: Snapshot[] = []
  const sides: Snapshot[] = []
  for (const file of files) {
    if (parseSyncConflictName(file.path) === null) mains.push(file)
    else sides.push(file)
  }
  const first = mains[0]
  const unchanged =
    item.lastMaterialised !== null &&
    sides.length === 0 &&
    mains.length === 1 &&
    first !== undefined &&
    first.text === item.lastMaterialised
  if (unchanged) {
    return item.tombstoned
      ? { action: "remove", removeAfterCommit: [], retainedSources: [] }
      : { action: "none", removeAfterCommit: [], retainedSources: [] }
  }
  const base = item.currentText ?? ""
  const fm = new Map<string, FmValue>()
  let body = ""
  const adoptFile = (raw: string, isMain: boolean): void => {
    const text = toLf(raw)
    const parsed = splitItem(text)
    const conflicts = adoptFrontmatter(fm, parsed.fm ?? [])
    const stripped = stripT2Blocks(parsed.body)
    conflicts.push(...adoptFrontmatter(fm, stripped.entries))
    const localDeletion =
      isMain && item.lastMaterialised !== null && isOrderedSubsequence(text, toLf(item.lastMaterialised))
    if (!localDeletion) body = merge(body, stripped.body)
    for (const conflict of conflicts) {
      if (!body.split(/(?<=\n)/).includes(conflict)) {
        if (body !== "" && !body.endsWith("\n")) body += "\n"
        body += conflict
      }
    }
  }
  adoptFile(base, false)
  for (const file of mains) adoptFile(file.text, true)
  for (const file of sides) adoptFile(file.text, false)
  const rendered = renderAssembled([...fm.entries()].map(([key, value]) => ({ key, value })), body)
  const removeAfterCommit: string[] = []
  const retainedSources: RetainedSource[] = []
  for (const side of sides) {
    const missing = firstMissingFact(rendered, toLf(side.text))
    if (missing === null) removeAfterCommit.push(side.path)
    else retainedSources.push({ path: side.path, reason: missing })
  }
  if (rendered === base) {
    return item.tombstoned
      ? { action: "remove", removeAfterCommit, retainedSources }
      : { action: "none", removeAfterCommit, retainedSources }
  }
  return { action: "capture", workingText: rendered, removeAfterCommit, retainedSources }
}
