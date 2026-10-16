// The read-back gate every adoption deletion goes through. It is structure-free: it never
// parses the source into blocks. Every raw source line (line endings normalised, nothing else)
// must appear in the merged result at least as many times as in the source. The only lines the
// adopt step may drop are the enumerated metadata lines (droppableAllowance) and key lines the
// result represents, each metadata kind bounded by a count taken from the source itself. A missing line that is none of those keeps the source.
// A key line is represented only by an active register entry or a set element of the result
// (sync-design #454 §3): a register line is accounted for when its value is one of the key's
// active entries, never because a joined " / " render happens to contain it.

import { splitItem, type FmValue } from "../item/frontmatter"

const T2_HEADER =
  /^<!-- memory-sync \d{4}-\d{2}-\d{2}: the other machine had different frontmatter for .+; kept here so no fact is lost:$/

export function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n")
}

export function linesOf(text: string): readonly string[] {
  if (text === "") return []
  const lines = text.split("\n")
  if (text.endsWith("\n")) lines.pop()
  return lines
}

function countLines(lines: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1)
  return counts
}

type ResultFact = { readonly kind: "reg"; readonly values: readonly string[] } | { readonly kind: "set"; readonly elements: readonly string[] }

function valueSurvives(wanted: FmValue, actual: ResultFact): boolean {
  const held = actual.kind === "reg" ? actual.values : actual.elements
  switch (wanted.kind) {
    case "set":
      return actual.kind === "set" ? wanted.elements.every((element) => held.includes(element)) : held.includes(wanted.flow)
    case "reg":
      return held.includes(wanted.value)
    case "remove":
      return false
  }
}

/** The result's keys: a register's components from `registers` when given, else its rendered value as one whole value. */
function resultFacts(rendered: string, registers: ReadonlyMap<string, readonly string[]> | undefined): Map<string, ResultFact> {
  const facts = new Map<string, ResultFact>()
  for (const { key, value } of splitItem(rendered).fm ?? []) {
    if (value.kind === "set") facts.set(key, { kind: "set", elements: value.elements })
    else if (value.kind === "reg") facts.set(key, { kind: "reg", values: registers?.get(key) ?? [value.value] })
  }
  return facts
}

/**
 * A single source line that, read alone as a one-key frontmatter header (T2 blocks escape
 * "-->" as "-- >"), names a key whose value the result represents. Line-local: no block
 * structure is consulted, and a multi-line value never qualifies (the source is kept).
 */
function isRepresentedKeyLine(line: string, facts: ReadonlyMap<string, ResultFact>): boolean {
  for (const candidate of new Set([line, line.replace(/-- >/g, "-->")])) {
    const entries = splitItem(`---\n${candidate}\n---\n`).fm
    if (entries === null || entries.length !== 1) continue
    const [entry] = entries
    const fact = entry === undefined ? undefined : facts.get(entry.key)
    if (entry !== undefined && fact !== undefined && valueSurvives(entry.value, fact)) return true
  }
  return false
}

/**
 * The enumerated metadata lines adoption may drop, each with how many of them a source may
 * lose: a T2 header carries no fact (all of them); per T2 header, one closing "-->" (or the
 * hub's fused "----->", its kept header's closing fence plus "-->"), one blank
 * separator and the block's two "---" fences; plus the two fences of the file's own header.
 */
function droppableAllowance(source: readonly string[]): Map<string, number> {
  const headers = source.filter((line) => T2_HEADER.test(line)).length
  return new Map([
    ["-->", headers],
    ["----->", headers],
    ["", headers],
    ["---", 2 + 2 * headers],
  ])
}

/**
 * Name the first source line (LF text) the merged result does not hold as many times as the
 * source does, after the enumerated metadata allowance and represented key lines. Null means
 * the source is safe to delete.
 */
export function firstMissingFact(
  rendered: string,
  source: string,
  registers?: ReadonlyMap<string, readonly string[]>,
): string | null {
  const sourceLines = linesOf(source)
  const have = countLines(linesOf(rendered))
  const allowance = droppableAllowance(sourceLines)
  const facts = resultFacts(rendered, registers)
  for (const [line, count] of countLines(sourceLines)) {
    const missing = count - (have.get(line) ?? 0)
    if (missing <= 0 || T2_HEADER.test(line)) continue
    const allowed = allowance.get(line)
    if (allowed !== undefined) {
      if (missing <= allowed) continue
      return `missing line ${JSON.stringify(line)} (${missing} dropped, ${allowed} allowed as metadata)`
    }
    if (isRepresentedKeyLine(line, facts)) continue
    return missing === count
      ? `missing line ${JSON.stringify(line)}`
      : `missing line ${JSON.stringify(line)} (${count} in the source, ${count - missing} merged)`
  }
  return null
}
