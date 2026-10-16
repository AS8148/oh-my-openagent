// What the engine writes to disk (lead decision r6, design (b)). The merged typed model decides
// the content; the file on disk decides the style:
// - a file whose typed model already equals the doc's is returned byte-for-byte, whatever its
//   quoting, spacing or comments;
// - otherwise the parsed disk Document is patched in place: keys whose typed value changed get
//   the new node, removed keys are deleted, new keys go at the end, so comments and quoting on
//   untouched keys survive and only changed keys are normalized (the yaml emitter keeps comments
//   and scalar quoting; it normalizes flow spacing such as `[a, b]` -> `[ a, b ]`);
// - when only the body changed, the disk's frontmatter bytes are kept exactly;
// - when the disk frontmatter does not parse, or the patched result would not parse back to
//   exactly the doc's model, the canonical render is written instead.
// A comment attached to a changed or removed key is not kept (the model has no comments).

import type { LoroDoc } from "../../crdt/loro-runtime"
import { isMap, parseDocument, stringify } from "yaml"

import type { FmValue } from "./frontmatter"
import { splitHeader, splitItem } from "./frontmatter"
import { bodyOf, frontmatterEntries, renderItem } from "./render"

interface Model {
  readonly fields: ReadonlyMap<string, string>
  readonly body: string
}

export function renderForDisk(doc: LoroDoc, diskText: string): string | null {
  const canonical = renderItem(doc)
  if (canonical === null) return null
  const want = modelOf(canonical)
  if (sameModel(want, modelOf(diskText))) return diskText
  const patched = patchDisk(doc, diskText, want)
  return patched !== null && sameModel(modelOf(patched), want) ? patched : canonical
}

function patchDisk(doc: LoroDoc, diskText: string, want: Model): string | null {
  const parts = splitHeader(diskText)
  const entries = frontmatterEntries(doc)
  if (parts === null || entries.length === 0) return null
  const disk = parseDocument(parts.header, { schema: "core", merge: true })
  if (disk.errors.length > 0 || !isMap(disk.contents)) return null
  const have = modelOf(diskText).fields
  if (sameFields(have, want.fields)) return `${diskText.slice(0, diskText.length - parts.body.length)}${bodyOf(doc)}`
  for (const key of have.keys()) if (!want.fields.has(key)) disk.delete(key)
  for (const { key, node } of entries) {
    if (have.get(key) !== want.fields.get(key)) disk.set(key, node)
  }
  return `---\n${stringify(disk, { lineWidth: 0 })}---\n${bodyOf(doc)}`
}

function modelOf(text: string): Model {
  const parsed = splitItem(text)
  const fields = new Map<string, string>()
  for (const { key, value } of parsed.fm ?? []) fields.set(key, fieldKey(value))
  return { fields, body: parsed.body }
}

// A set is compared as a set: element order on disk is style.
function fieldKey(value: FmValue): string {
  return value.kind === "set" ? JSON.stringify(["set", [...value.elements].sort()]) : JSON.stringify(value)
}

function sameModel(a: Model, b: Model): boolean {
  return a.body === b.body && sameFields(a.fields, b.fields)
}

function sameFields(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [key, value] of a) if (b.get(key) !== value) return false
  return true
}
