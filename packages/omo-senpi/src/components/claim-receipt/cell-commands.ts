import { type InvokedKind, invokedKinds } from "./invocations"

export type CellCheckKind = Exclude<InvokedKind, "lookup">

const STRING_LITERAL = /"""[\s\S]*?"""|'''[\s\S]*?'''|`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g
const LIST_OF_STRINGS = /\[\s*(?:"""|'''|[`'"])[^\[\]]*\]/g
const QUOTES = /^(?:"""|'''|[`'"])|(?:"""|'''|[`'"])$/g
const LITERAL_PREFIX = /^(?:f|r|rf|fr|b)?$/i
const INTERPOLATION = /\$\{[^}]*\}|\{[A-Za-z_][\w.]*\}/g
const CONTEXT_WINDOW = 80
// Positions that carry a command line, the only places a literal counts as one: the first argument of a runner call
// (sh/run/exec/spawn/system/Popen/check_output, shell-named helpers such as s, sh2, shr, rd, q, ssh*, *_run), a runner
// template tag ($`...`, sh`...`), a command-like field or variable (command:, cmd =, script:, job =, s = f"""...),
// a [name, command] pair nested in a list, and the list of a for loop (`for c in ["bun test x", ...]`). Everything else is text, so an unknown position fails toward "not a command".
const RUNNER = String.raw`(?:sh\w*|run\w*|exec\w*|spawn\w*|\w+_(?:run|sh|exec|cmd)|system|popen|Popen|check_output|check_call|call|shell|bash|zsh|ssh\w*|rsh|rd|q|s|\$)`
const COMMAND_CONTEXT = new RegExp(
  [
    String.raw`(?:^|[^\w$])${RUNNER}\s*\(\s*(?:\[\s*)?[A-Za-z]{0,2}$`,
    String.raw`(?:^|[^\w])(?:\$|sh|run|exec)\s*$`,
    String.raw`\b(?:command|commands|cmd|cmds|script|scripts|shell|job|jobs|steps?|s)\w*\s*[:=]\s*(?:\[\s*)?[A-Za-z]{0,2}$`,
    String.raw`(?:\[|\],)\s*$`,
    String.raw`\bfor\s*\(?\s*(?:const|let|var)?\s*\w+\s+(?:in|of)\s*$`,
  ].join("|"),
)

const isCommand = (code: string, at: number): boolean => COMMAND_CONTEXT.test(code.slice(Math.max(0, at - CONTEXT_WINDOW), at))
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
 * literals in command positions (see COMMAND_CONTEXT) are parsed as command lines, so prints, file contents, asserts,
 * labels and any unknown position never count; lookups are dropped because cells grep and cat for many reasons besides proving existence.
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
    if (isCommand(code, match.index)) found(match.index, listKinds(match[0]))
  }
  for (const match of code.matchAll(STRING_LITERAL)) {
    if (inLists.some(([start, end]) => match.index >= start && match.index < end)) continue
    if (isCommand(code, match.index)) found(match.index, checkKinds(unquote(match[0])))
  }
  return { kinds, offset }
}
