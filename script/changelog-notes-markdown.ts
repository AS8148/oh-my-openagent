/**
 * The one Markdown reading the changelog release uses (#10477 review rounds 2-3): which lines sit inside a code
 * fence, and where an entry's PR link goes. Fences follow CommonMark: a fence opens with three or more ` or ~,
 * and only a line of the same character, at least as long, with nothing after it, closes it. An unclosed fence is
 * an error, so the PR check refuses it before the fragment becomes immutable. A fence may be indented at most three
 * spaces past the text column of the list item it sits in (column 0 outside a list); deeper is an indented code line.
 * List items follow CommonMark too: a `-`, `*` or `+` bullet or a `1.` / `1)` number, whose text column is the
 * marker's column plus its width plus the spaces after it (one when there are more than four or none).
 */

const OPEN = /^(`{3,}|~{3,})/
const LIST_MARKER = /^([-*+]|\d{1,9}[.)])( +|$)/

export type ScannedLine = { readonly text: string; readonly fenced: boolean }

/** Leading whitespace width, a tab counting as four columns. */
const indentOf = (line: string): number => [...(/^[ \t]*/.exec(line)?.[0] ?? "")].reduce((width, char) => width + (char === "\t" ? 4 : 1), 0)

/** Every line with whether it belongs to a fenced block (the fence lines themselves included). */
export function scanFences(text: string): ScannedLine[] {
  const lines: ScannedLine[] = []
  let open: { readonly marker: string; readonly base: number } | null = null
  // Text columns of the list items the current line can belong to, innermost last.
  const items: number[] = []
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const stripped = line.replace(/^\s*/, "")
    const indent = indentOf(line)
    if (open === null) {
      if (stripped !== "") while ((items.at(-1) ?? 0) > indent) items.pop()
      const item = items.at(-1) ?? 0
      const listMarker = indent - item <= 3 ? LIST_MARKER.exec(stripped) : null
      if (listMarker !== null) {
        const gap = listMarker[2]?.length ?? 0
        items.push(indent + (listMarker[1]?.length ?? 0) + (gap >= 1 && gap <= 4 ? gap : 1))
      }
      const candidate = listMarker === null && indent - item <= 3 ? OPEN.exec(stripped)?.[1] : undefined
      const marker = candidate !== undefined && !(candidate[0] === "`" && stripped.slice(candidate.length).includes("`")) ? candidate : undefined
      if (marker !== undefined) open = { marker, base: item }
      lines.push({ text: line, fenced: marker !== undefined })
    } else {
      lines.push({ text: line, fenced: true })
      const close = new RegExp(`^\\${open.marker[0]}{${open.marker.length},}\\s*$`)
      if (indent - open.base <= 3 && close.test(stripped)) open = null
    }
  }
  if (open !== null) throw new Error(`a code fence (${open.marker}) is never closed`)
  return lines
}

/** Blank-line-separated blocks; a blank line inside a fence does not end a block. */
export function blocksOf(text: string): string[] {
  const blocks: string[] = []
  let current: string[] = []
  for (const line of scanFences(text)) {
    if (!line.fenced && line.text.trim() === "") {
      if (current.length > 0) blocks.push(current.join("\n"))
      current = []
    } else {
      current.push(line.text)
    }
  }
  if (current.length > 0) blocks.push(current.join("\n"))
  return blocks
}

/**
 * The entry with a link to `pr` unless it already links this repository's PR `pr` (duty ruling, #10477 r3). Links to
 * other PRs, in this repository or any other, never count, so an upstream citation keeps our credit and a folded
 * car's entry names both the car and the batch. The link goes at the end of the entry's last line outside any fence,
 * so code is never touched; an entry that is all code stays as written.
 */
export function linkEntry(entry: string, pr: number, pullUrl: string): string {
  const lines = scanFences(entry)
  if (lines.some((line) => !line.fenced && line.text.includes(`${pullUrl}/${pr})`))) return entry
  const last = lines.findLastIndex((line) => !line.fenced && line.text.trim() !== "")
  if (last === -1) return entry
  return lines.map((line, index) => (index === last ? `${line.text.trimEnd()} ([#${pr}](${pullUrl}/${pr}))` : line.text)).join("\n")
}
