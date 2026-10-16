// Drift merge on the item model (review r4 HIGH): three item texts (base = what an earlier
// capture already applied, ours = the user's file now, theirs = the doc state that capture
// produced) are parsed into the body and typed frontmatter fields and merged per field:
// - a field only one side changed takes that side;
// - the body and text-kind fields merge as text (Loro text merge, three-way);
// - set fields merge element-wise: theirs, plus what ours added, minus what ours removed;
// - a register field the user changed takes the user's value. Whether that value replaces
//   or joins a concurrent value is decided by the CRDT write (capture supersedes only the
//   values the user saw), never by splicing serialized text.
// Rendered text is only the output handed to capture, which parses it back into fields.

import type { FmEntry, FmValue } from "./frontmatter"
import { renderEntry, splitItem } from "./frontmatter"
import { mergeText } from "./three-way"

type Field = FmValue | undefined

export async function mergeFields(base: string, ours: string, theirs: string): Promise<string> {
  if (ours === base || ours === theirs) return theirs
  if (theirs === base) return ours
  // A file without (valid) frontmatter is, in the item model, a body with no fields.
  const b = splitItem(base)
  const o = splitItem(ours)
  const t = splitItem(theirs)
  const baseFields = fieldsOf(b.fm ?? [])
  const ourFields = fieldsOf(o.fm ?? [])
  const theirFields = fieldsOf(t.fm ?? [])
  const keys = [...theirFields.keys(), ...[...ourFields.keys()].filter((k) => !theirFields.has(k))]
  const lines: string[] = []
  for (const key of keys) {
    const merged = await mergeField(baseFields.get(key), ourFields.get(key), theirFields.get(key))
    if (merged !== undefined && merged.kind !== "remove") lines.push(renderField(key, merged))
  }
  const body = await mergeText(b.body, o.body, t.body)
  return lines.length === 0 ? body : `---\n${lines.join("\n")}\n---\n${body}`
}

async function mergeField(base: Field, ours: Field, theirs: Field): Promise<Field> {
  if (sameField(ours, base)) return theirs
  if (sameField(theirs, base) || sameField(ours, theirs)) return ours
  if (ours === undefined || theirs === undefined || ours.kind === "remove" || theirs.kind === "remove") return ours
  if (ours.kind === "set" || theirs.kind === "set") {
    const removed = new Set(elementsOf(base).filter((e) => !elementsOf(ours).includes(e)))
    const kept = elementsOf(theirs).filter((e) => !removed.has(e))
    const added = elementsOf(ours).filter((e) => !kept.includes(e) && !elementsOf(base).includes(e))
    const elements = [...kept, ...added]
    return { kind: "set", elements, flow: `[${elements.join(", ")}]` }
  }
  if (ours.kind === "text" && theirs.kind === "text") {
    return { kind: "text", text: await mergeText(base?.kind === "text" ? base.text : "", ours.text, theirs.text) }
  }
  return ours
}

function fieldsOf(entries: readonly FmEntry[]): Map<string, FmValue> {
  return new Map(entries.map((entry) => [entry.key, entry.value]))
}

function elementsOf(field: Field): readonly string[] {
  if (field === undefined || field.kind === "remove") return []
  if (field.kind === "set") return field.elements
  return [field.kind === "text" ? field.text : field.value]
}

function sameField(a: Field, b: Field): boolean {
  if (a === undefined || b === undefined) return a === b
  return JSON.stringify(a) === JSON.stringify(b)
}

function renderField(key: string, field: Exclude<FmValue, { kind: "remove" }>): string {
  if (field.kind === "set") return renderEntry(key, field.elements)
  if (field.kind === "reg") return renderEntry(key, field.value, true)
  return renderEntry(key, field.text)
}
