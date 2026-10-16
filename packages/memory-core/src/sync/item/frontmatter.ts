// Frontmatter split and typing (sync-design §2). The split grammar is the one the
// repository already uses (leading "---" line, closing "---" line). A block that is not
// valid YAML, is empty, or is not a mapping has no frontmatter part: the whole file is
// the body, so text is never lost to a parse failure. A key's CRDT kind is declared by the
// YAML node type of its value, never by its length or content (review r5, lead decision):
// every scalar (string, number, boolean, date) -> multi-value register holding its canonical
// YAML source, mapping -> register holding its YAML flow source, sequence -> set,
// null -> removal. Only the body is text: concurrent edits to one frontmatter value keep both
// whole values (a register conflict) instead of being merged character by character.

import { Document, Scalar, YAMLSeq, isMap, isScalar, isSeq, parseDocument, stringify } from "yaml"

export type FmValue =
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

export function splitItem(text: string): ParsedItemText {
  if (!text.startsWith("---\n")) return { fm: null, body: text }
  const end = text.indexOf("\n---", 4)
  if (end < 0) return { fm: null, body: text }
  const nl = text.indexOf("\n", end + 4)
  const closeEnd = nl < 0 ? text.length : nl
  if (text.slice(end + 4, closeEnd).trim() !== "") return { fm: null, body: text }
  const header = text.slice(4, end)
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
  if (verbatim && typeof value === "string" && !value.includes("\n---")) {
    const candidate = `${renderScalar(key)}: ${value}`
    const check = parseDocument(candidate, { schema: "core" })
    if (check.errors.length === 0) {
      const contents = check.contents
      if (contents !== null && isMap(contents) && contents.items.length === 1) {
        const pair = contents.items[0]
        if (pair !== undefined && (isScalar(pair.value) || isMap(pair.value) || isSeq(pair.value))) return candidate
      }
    }
  }
  const doc = new Document({}, { schema: "core" })
  doc.set(key, typeof value === "string" ? doubleQuoted(value) : sequenceOf(value))
  const out = stringify(doc).trimEnd()
  if (doc.errors.length > 0) throw new Error(`renderEntry: cannot render key ${JSON.stringify(key)}: ${doc.errors[0]?.message}`)
  return out
}

/**
 * Set elements are stored as canonical YAML sources. Re-parse each one into its node so the
 * emitter keeps its exact type and style (a number stays a number, a quoted string stays
 * quoted, a flow map stays a flow map) and indents block scalars under the dash.
 */
function doubleQuoted(value: string): Scalar {
  const scalar = new Scalar(value)
  scalar.type = "QUOTE_DOUBLE"
  return scalar
}

function sequenceOf(sources: readonly string[]): YAMLSeq {
  const seq = new YAMLSeq()
  for (const source of sources) {
    const parsed = parseDocument(source, { schema: "core" })
    const node = parsed.errors.length === 0 ? parsed.contents : null
    seq.items.push(node ?? source)
  }
  return seq
}

// Aliases and merge keys resolve BEFORE classification (spec #454): a value is classified by
// what it resolves to. A custom tag (one the core schema cannot resolve) or an alias bomb makes
// the frontmatter invalid, so the whole file stays body and nothing is lost.
function parseHeader(header: string): readonly FmEntry[] | null {
  const doc = parseDocument(header, { schema: "core", merge: true })
  if (doc.errors.length > 0 || doc.warnings.some((w) => w.code === "TAG_RESOLVE_FAILED")) return null
  const contents = doc.contents
  if (contents === null || !isMap(contents)) return null
  for (const pair of contents.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") return null
  }
  let resolved: unknown
  try {
    resolved = doc.toJS({ maxAliasCount: 64 })
  } catch (error) {
    if (error instanceof ReferenceError || error instanceof TypeError) return null
    throw error
  }
  if (typeof resolved !== "object" || resolved === null || Array.isArray(resolved)) return null
  return Object.entries(resolved).map(([key, value]) => ({ key, value: classify(value) }))
}

function classify(value: unknown): FmValue {
  if (value === null || value === undefined) return { kind: "remove" }
  if (Array.isArray(value)) return { kind: "set", elements: value.map(elementSource), flow: flowOf(value) }
  if (typeof value === "object") return { kind: "reg", value: flowOf(value) }
  return { kind: "reg", value: scalarSource(value) }
}

function elementSource(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (typeof value === "object") return flowOf(value)
  return scalarSource(value)
}

function scalarSource(value: unknown): string {
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") return renderScalar(value)
  return renderScalar(String(value))
}

function flowOf(node: unknown): string {
  return stringify(node, { collectionStyle: "flow" }).trim()
}
