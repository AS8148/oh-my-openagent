// The read-back gate every adoption deletion goes through. It reads the source line by line
// on its own and never calls stripT2Blocks, so a defect in the strip cannot hide on both
// sides of the check. Body lines are compared as counts: a merge that keeps one of two
// identical lines has lost a fact.

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

/**
 * A source's facts: its body lines with each well-formed T2 block (and the one blank
 * separator line the hub writes before it) taken out, and its frontmatter entries plus
 * every entry kept inside those blocks. A block that does not parse stays body text.
 */
function sourceFacts(source: string): { readonly body: readonly string[]; readonly entries: readonly FmEntry[] } {
  const parsed = splitItem(source)
  const lines = linesOf(parsed.body)
  const body: string[] = []
  const entries: FmEntry[] = [...(parsed.fm ?? [])]
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    const end = T2_HEADER.test(line) ? lines.indexOf("-->", i + 1) : -1
    const kept = end === -1 ? null : splitItem(lines.slice(i + 1, end).map((l) => `${l.replace(/-- >/g, "-->")}\n`).join("")).fm
    if (kept === null) {
      body.push(line)
      continue
    }
    if (body.at(-1) === "") body.pop()
    entries.push(...kept)
    i = end
  }
  return { body, entries: entries.filter((entry) => entry.value.kind !== "remove") }
}

/**
 * Name the first fact of `source` (LF text) the merged result does not represent: a body
 * line present fewer times than in the source, or a frontmatter value neither merged into
 * its key nor kept as a marked conflict. Null means the source is safe to delete.
 */
export function firstMissingFact(rendered: string, source: string): string | null {
  const from = sourceFacts(source)
  const into = splitItem(rendered)
  const have = countLines(linesOf(into.body))
  for (const [line, count] of countLines(from.body)) {
    const found = have.get(line) ?? 0
    if (found === 0) return `missing body line ${JSON.stringify(line)}`
    if (found < count) return `missing body line ${JSON.stringify(line)} (${count} in the source, ${found} merged)`
  }
  const candidates: FmEntry[] = [...(into.fm ?? [])]
  for (const line of linesOf(into.body)) {
    const match = CONFLICT_LINE.exec(line)
    if (match !== null) candidates.push(...(splitItem(`---\n${match[1]}\n---\n`).fm ?? []))
  }
  for (const { key, value } of from.entries) {
    if (!candidates.some((candidate) => candidate.key === key && valueSurvives(value, candidate.value))) {
      return `missing frontmatter key ${JSON.stringify(key)}`
    }
  }
  return null
}
