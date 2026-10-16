// The read-back gate every adoption deletion goes through. It is structure-free: it never
// parses the source into blocks. Every raw source line (line endings normalised, nothing else)
// must appear in the merged result at least as many times as in the source. The only lines the
// adopt step may drop are the enumerated metadata lines (droppableAllowance) and key lines the
// result represents, each metadata kind bounded by a count taken from the source itself. A missing line that is none of those keeps the source.

import { splitItem, type FmEntry, type FmValue } from "../item/frontmatter"

const T2_HEADER =
  /^<!-- memory-sync \d{4}-\d{2}-\d{2}: the other machine had different frontmatter for .+; kept here so no fact is lost:$/
const CONFLICT_LINE = /^<!-- memory-sync frontmatter conflict: (.+) -->$/

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

function coversLines(wanted: readonly string[], actual: readonly string[]): boolean {
  const have = countLines(actual)
  return [...countLines(wanted)].every(([line, count]) => (have.get(line) ?? 0) >= count)
}

function valueSurvives(wanted: FmValue, actual: FmValue): boolean {
  switch (wanted.kind) {
    case "text":
      return actual.kind === "text" && coversLines(linesOf(wanted.text), linesOf(actual.text))
    case "set":
      return actual.kind === "set" && wanted.elements.every((element) => actual.elements.includes(element))
    case "reg":
      return actual.kind === "reg" && actual.value === wanted.value
    case "remove":
      return true // A null is a removal request, not an adopted value.
  }
}

/** Every frontmatter fact the result represents: its own keys plus marked conflict payloads. */
function resultFacts(rendered: string): readonly FmEntry[] {
  const into = splitItem(rendered)
  const facts: FmEntry[] = [...(into.fm ?? [])]
  for (const line of linesOf(into.body)) {
    const match = CONFLICT_LINE.exec(line)
    if (match !== null) facts.push(...(splitItem(`---\n${match[1]}\n---\n`).fm ?? []))
  }
  return facts
}

/**
 * A single source line that, read alone as a one-key frontmatter header (T2 blocks escape
 * "-->" as "-- >"), names a key whose value the result represents. Line-local: no block
 * structure is consulted, and a multi-line value never qualifies (the source is kept).
 */
function isRepresentedKeyLine(line: string, facts: readonly FmEntry[]): boolean {
  for (const candidate of new Set([line, line.replace(/-- >/g, "-->")])) {
    const entries = splitItem(`---\n${candidate}\n---\n`).fm
    if (entries === null || entries.length !== 1) continue
    const [entry] = entries
    if (entry !== undefined && entry.value.kind !== "remove" && facts.some((fact) => fact.key === entry.key && valueSurvives(entry.value, fact.value))) {
      return true
    }
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
export function firstMissingFact(rendered: string, source: string): string | null {
  const sourceLines = linesOf(source)
  const have = countLines(linesOf(rendered))
  const allowance = droppableAllowance(sourceLines)
  const facts = resultFacts(rendered)
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
