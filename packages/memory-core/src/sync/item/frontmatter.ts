// Frontmatter split and typing (sync-design §2). The split grammar is the one the
// repository already uses (leading "---" line, closing "---" line). A block that is not
// valid YAML, is empty, or is not a mapping has no frontmatter part: the whole file is
// the body, so text is never lost to a parse failure. A key's CRDT kind comes from the
// YAML type of its value: string -> text, sequence -> set, boolean/number/date ->
// register, mapping -> text holding its YAML flow serialisation, null -> removal.

import { Document, YAMLSeq, isMap, isScalar, isSeq, parseDocument, stringify } from "yaml"
import type { Node } from "yaml"

export type FmValue =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "set"; readonly elements: readonly string[]; readonly flow: string }
  | { readonly kind: "reg"; readonly value: string }
  | { readonly kind: "remove" }

export interface FmEntry {
  readonly key: string
  readonly value: FmValue
}

export interface ParsedItemText {
  readonly fm: readonly FmEntry[] | null
  readonly body: string
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/

export function splitItem(text: string): ParsedItemText {
  const sep = text.startsWith("---\r\n") ? "\r\n" : "\n"
  if (!text.startsWith(`---${sep}`)) return { fm: null, body: text }
  const open = 3 + sep.length
  const end = text.indexOf(`${sep}---`, open)
  if (end < 0) return { fm: null, body: text }
  const close = end + sep.length + 3
  const nl = text.indexOf("\n", close)
  const closeEnd = nl < 0 ? text.length : nl
  if (text.slice(close, closeEnd).trim() !== "") return { fm: null, body: text }
  const header = text.slice(open, end)
  if (header.trim() === "") return { fm: null, body: text }
  const fm = parseHeader(header)
  if (fm === null) return { fm: null, body: text }
  return { fm, body: nl < 0 ? "" : text.slice(nl + 1) }
}

/** Canonical scalar source for storage and render; strict-YAML round-trip safe. */
export function renderScalar(value: string | number | boolean): string {
  return stringify(value).trim()
}

/**
 * Canonical frontmatter line(s) for one key (sync-design §2). The pair is built through
 * the yaml document builder so multiline text lands as a properly indented block scalar
 * and any joined text is quoted exactly when re-parsing needs it. A verbatim value is
 * already a serialized YAML scalar (a lone register's stored form): it is emitted as-is
 * when it re-parses as one scalar, and falls back to the string form otherwise. Capture
 * compares keys against this render, so the same builder keeps the round trip a zero-op
 * fixed point.
 */
export function renderEntry(key: string, value: string | readonly string[], verbatim = false): string {
  if (verbatim && typeof value === "string") {
    const candidate = `${renderScalar(key)}: ${value}`
    const check = parseDocument(candidate, { schema: "core" })
    if (check.errors.length === 0) {
      const contents = check.contents
      if (contents !== null && isMap(contents) && contents.items.length === 1) {
        const pair = contents.items[0]
        if (pair !== undefined && isScalar(pair.value)) return candidate
      }
    }
  }
  const doc = new Document({}, { schema: "core" })
  doc.set(key, typeof value === "string" ? value : sequenceOf(value))
  const out = stringify(doc).trimEnd()
  if (doc.errors.length > 0) throw new Error(`renderEntry: cannot render key ${JSON.stringify(key)}: ${doc.errors[0]?.message}`)
  return out
}

/**
 * Set elements are stored as canonical YAML sources. Re-parse each one into its node so the
 * emitter keeps its exact type and style (a number stays a number, a quoted string stays
 * quoted, a flow map stays a flow map) and indents block scalars under the dash.
 */
function sequenceOf(sources: readonly string[]): YAMLSeq {
  const seq = new YAMLSeq()
  for (const source of sources) {
    const parsed = parseDocument(source, { schema: "core" })
    const node = parsed.errors.length === 0 ? parsed.contents : null
    seq.items.push(node ?? source)
  }
  return seq
}

function parseHeader(header: string): readonly FmEntry[] | null {
  const doc = parseDocument(header, { schema: "core" })
  if (doc.errors.length > 0) return null
  const contents = doc.contents
  if (contents === null || !isMap(contents)) return null
  const entries: FmEntry[] = []
  for (const pair of contents.items) {
    const keyNode = pair.key
    if (!isScalar(keyNode) || typeof keyNode.value !== "string") return null
    entries.push({ key: keyNode.value, value: classify(header, pair.value ?? null) })
  }
  return entries
}

function classify(header: string, node: Node | null): FmValue {
  if (node === null) return { kind: "remove" }
  if (isScalar(node)) {
    const value: unknown = node.value
    if (value === null || value === undefined) return { kind: "remove" }
    if (typeof value === "boolean" || typeof value === "number") {
      return { kind: "reg", value: renderScalar(value) }
    }
    const text = String(value)
    const source = nodeSource(header, node)
    if (source !== null && !source.startsWith("'") && !source.startsWith('"') && DATE_RE.test(source)) {
      return { kind: "reg", value: renderScalar(text) }
    }
    return { kind: "text", text }
  }
  if (isSeq(node)) {
    const elements = node.items.map((item) => elementSource(header, item))
    return { kind: "set", elements, flow: flowOf(node) }
  }
  if (isMap(node)) return { kind: "text", text: flowOf(node) }
  return { kind: "text", text: flowOf(node) }
}

function elementSource(header: string, item: unknown): string {
  if (isScalar(item)) {
    const value: unknown = item.value
    if (value === null || value === undefined) return "null"
    if (typeof value === "string") return renderScalar(value)
    if (typeof value === "boolean" || typeof value === "number") return renderScalar(value)
    return renderScalar(String(value))
  }
  if (typeof item === "object" && item !== null) return flowOf(item)
  return "null"
}

function flowOf(node: unknown): string {
  return stringify(node, { collectionStyle: "flow" }).trim()
}

function nodeSource(header: string, node: Node): string | null {
  const range = node.range
  if (range === null || range === undefined) return null
  return header.slice(range[0], range[1]).trim()
}
