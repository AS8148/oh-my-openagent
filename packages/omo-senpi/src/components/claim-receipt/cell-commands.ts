import { type InvokedKind, invokedKinds } from "./invocations"

export type CellCheckKind = Exclude<InvokedKind, "lookup">

const STRING_LITERAL = /"""[\s\S]*?"""|'''[\s\S]*?'''|`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g
const LIST_OF_STRINGS = /\[\s*(?:"""|'''|[`'"])[^\[\]]*\]/g
const QUOTES = /^(?:"""|'''|[`'"])|(?:"""|'''|[`'"])$/g
const LITERAL_PREFIX = /^(?:f|r|rf|fr|b)?$/i
const INTERPOLATION = /\$\{[^}]*\}|\{[A-Za-z_][\w.]*\}/g
const CONTEXT_WINDOW = 80
// Places where a literal is text rather than a command: printed or logged, written into a file, asserted on,
// searched for, used to patch source, or stored under a label-like name. Every other literal handed to code
// (helpers such as sh(), q(), run(), template tags, `command:` fields) is read as a command line.
const TEXT_CONTEXT = new RegExp(
  [
    String.raw`\b(?:print|log|info|warn|warning|error|debug|display|echo|write|write_text|write_bytes|writeFile|writeFileSync|appendFile|appendFileSync|assert|expect|toEqual|toStrictEqual|toBe|toContain|toMatch|includes|replace|replaceAll|startsWith|endsWith|find|index|count|search|match|split|join|send|reply|post|report|notify|format)\s*\(\s*(?:[^()]*?,\s*)?[A-Za-z]{0,2}$`,
    String.raw`\b(?:assert|if|elif|while|not|and|or)\s+[A-Za-z]{0,2}$`,
    String.raw`(?:==|!=|===|!==)\s*[A-Za-z]{0,2}$`,
    String.raw`\b(?:label|title|name|text|message|msg|description|desc|summary|note|body|entry|header|pattern|needle|old|new|oldText|newText|old_string|new_string|expected)\s*[:=]\s*[A-Za-z]{0,2}$`,
  ].join("|"),
)

const isText = (code: string, at: number): boolean => TEXT_CONTEXT.test(code.slice(Math.max(0, at - CONTEXT_WINDOW), at))
const unquote = (literal: string): string => literal.replace(QUOTES, "").replace(INTERPOLATION, "X")
const shellQuote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`
const checkKinds = (line: string): CellCheckKind[] => invokedKinds(line).filter((kind): kind is CellCheckKind => kind !== "lookup")

// A list such as ["gh", "pr", "checks", n] is one argv (subprocess.run, Bun.spawn): non-literal elements stand in as X.
function listWords(list: string): string[] {
  const words: string[] = []
  for (const element of list.slice(1, -1).split(",")) {
    const trimmed = element.trim()
    if (trimmed === "") continue
    const literal = trimmed.match(STRING_LITERAL)?.[0]
    const isLiteral = literal !== undefined && trimmed.endsWith(literal) && LITERAL_PREFIX.test(trimmed.slice(0, -literal.length))
    words.push(isLiteral ? unquote(literal) : "X")
  }
  return words
}

// A list whose elements contain spaces is a list of whole command lines (`for c in ["bun test x", "tsgo"]: sh(c)`), so
// each element is also read on its own; a plain argv list never has spaces inside its words.
function listKinds(list: string): CellCheckKind[] {
  const words = listWords(list)
  const lines = words.some((word) => /\s/.test(word)) ? words : []
  return [...checkKinds(words.map(shellQuote).join(" ")), ...lines.flatMap(checkKinds)]
}

/**
 * Check kinds run by shell strings inside eval cell code, with the offset of the first such string. Only string
 * literals in command positions are parsed as command lines, so prints, file contents, asserts and labels about a
 * check never count; lookups are dropped because cells grep and cat for many reasons besides proving existence.
 */
export function cellInvokedKinds(code: string): { kinds: CellCheckKind[]; offset: number } {
  const kinds: CellCheckKind[] = []
  let offset = -1
  const found = (at: number, more: readonly CellCheckKind[]) => {
    if (more.length === 0) return
    if (offset === -1 || at < offset) offset = at
    for (const kind of more) if (!kinds.includes(kind)) kinds.push(kind)
  }
  const inLists: Array<readonly [number, number]> = []
  for (const match of code.matchAll(LIST_OF_STRINGS)) {
    inLists.push([match.index, match.index + match[0].length])
    if (!isText(code, match.index)) found(match.index, listKinds(match[0]))
  }
  for (const match of code.matchAll(STRING_LITERAL)) {
    if (inLists.some(([start, end]) => match.index >= start && match.index < end)) continue
    if (!isText(code, match.index)) found(match.index, checkKinds(unquote(match[0])))
  }
  return { kinds, offset }
}
