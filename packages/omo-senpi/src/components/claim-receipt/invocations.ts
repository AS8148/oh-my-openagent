export type InvokedKind = "test" | "typecheck" | "lint" | "build" | "run" | "lookup"

const MAX_DEPTH = 3
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const SLOT_WRAPPERS = /(?:^|\/)(?:heavy-slot|early-static-slot|launch-detached)\.sh$/
const SHELLS = new Set(["bash", "sh", "zsh"])
const PASSTHROUGH = new Set(["env", "time", "nohup", "command", "exec", "sudo"])
const RUNNERS = new Set(["bun", "npm", "pnpm", "yarn"])
const PACKAGE_EXEC = new Set(["bunx", "npx", "pnpx"])
const LOOKUP_TOOLS = new Set(["rg", "grep", "egrep", "cat", "head", "tail", "ls", "find", "fd", "sg", "ast-grep"])

// Splits a shell command line into argv segments at `&&`, `||`, `;`, `|`, `&` and newlines, honouring single and
// double quotes so a quoted `&&` or a quoted check name stays inside its argument.
export function shellSegments(line: string): string[][] {
  const segments: string[][] = []
  let argv: string[] = []
  let word = ""
  let inWord = false
  let quote: "'" | '"' | null = null
  const endWord = () => {
    if (inWord) argv.push(word)
    word = ""
    inWord = false
  }
  const endSegment = () => {
    endWord()
    if (argv.length > 0) segments.push(argv)
    argv = []
  }
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] as string
    if (quote !== null) {
      if (char === quote) quote = null
      else word += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      inWord = true
      continue
    }
    if (char === "\\" && index + 1 < line.length) {
      word += line[index + 1]
      inWord = true
      index += 1
      continue
    }
    if (char === "\n" || char === ";" || char === "|" || char === "&") {
      endSegment()
      continue
    }
    if (char === " " || char === "\t") {
      endWord()
      continue
    }
    word += char
    inWord = true
  }
  endSegment()
  return segments
}

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1)

function skipTimeout(argv: readonly string[]): readonly string[] {
  let index = 1
  while (index < argv.length && (argv[index] as string).startsWith("-")) {
    const flag = argv[index] as string
    index += flag === "-k" || flag === "-s" || flag === "--kill-after" || flag === "--signal" ? 2 : 1
  }
  return argv.slice(index + 1)
}

function scriptKind(script: string): InvokedKind | undefined {
  if (/^test(?::|$)/.test(script)) return "test"
  if (/^(?:typecheck|type-check)(?::|$)/.test(script)) return "typecheck"
  if (/^lint(?::|$)/.test(script)) return "lint"
  if (/^build(?::|$)/.test(script)) return "build"
  return undefined
}

function toolKinds(exe: string, rest: readonly string[]): InvokedKind[] {
  const [first = "", second = ""] = rest
  if (exe === "vitest" || exe === "jest" || exe === "pytest") return ["test"]
  if (exe === "playwright" && first === "test") return ["test"]
  if (exe === "tsc" || exe === "tsgo" || exe === "mypy" || exe === "pyright") return ["typecheck"]
  if (exe === "eslint" || exe === "oxlint" || exe === "ruff") return ["lint"]
  if (exe === "biome" && ["check", "lint", "ci"].includes(first)) return ["lint"]
  if (exe === "cargo") {
    if (first === "test") return ["test"]
    if (first === "check") return ["typecheck"]
    if (first === "clippy") return ["lint"]
    if (first === "build") return ["build"]
  }
  if (exe === "go" && (first === "test" || first === "build")) return [first === "test" ? "test" : "build"]
  if (exe === "deno" && first === "test") return ["test"]
  if ((exe === "vite" || exe === "next") && first === "build") return ["build"]
  if (exe === "gh" && first === "pr" && second === "checks") return ["test"]
  if (exe === "vp") {
    if (first === "test") return ["test"]
    if (first === "check") return ["typecheck", "lint"]
    if (first === "lint") return ["lint"]
    if (first === "run") return rest.slice(1).flatMap((arg) => { const kind = scriptKind(arg); return kind ? [kind] : [] })
  }
  if (RUNNERS.has(exe)) {
    if (exe === "bun" && first === "test") return ["test"]
    if (exe === "bun" && first === "build") return ["build"]
    if (first === "run") { const kind = scriptKind(second); return kind ? [kind] : [] }
    if (exe !== "bun" && first === "test") return ["test"]
    if ((exe === "bun" || exe === "node") && rest.some((arg) => arg.includes("scripts/qa/"))) return ["run"]
  }
  if ((exe === "node" || exe === "tsx") && rest.some((arg) => arg.includes("scripts/qa/"))) return ["run"]
  if (LOOKUP_TOOLS.has(exe)) return ["lookup"]
  if (exe === "git" && (first === "grep" || first === "show")) return ["lookup"]
  return []
}

function argvKinds(argv: readonly string[], depth: number): InvokedKind[] {
  let rest = argv
  while (rest.length > 0 && ASSIGNMENT.test(rest[0] as string)) rest = rest.slice(1)
  if (rest.length === 0) return []
  const exe = basename(rest[0] as string)
  if (PASSTHROUGH.has(exe)) return argvKinds(rest.slice(1), depth)
  if (exe === "timeout") return argvKinds(skipTimeout(rest), depth)
  if (exe === "nice") return argvKinds(rest[1] === "-n" ? rest.slice(3) : rest.slice(1), depth)
  if (SLOT_WRAPPERS.test(rest[0] as string)) {
    const separator = rest.indexOf("--")
    return separator === -1 ? [] : argvKinds(rest.slice(separator + 1), depth)
  }
  if (SHELLS.has(exe)) {
    const flagIndex = rest.findIndex((arg, index) => index > 0 && /^-[a-z]*c$/.test(arg))
    const script = flagIndex === -1 ? undefined : rest[flagIndex + 1]
    return script === undefined || depth >= MAX_DEPTH ? [] : invokedKinds(script, depth + 1)
  }
  if (PACKAGE_EXEC.has(exe)) return argvKinds(rest.slice(1).filter((arg) => !arg.startsWith("-")), depth)
  if (exe === "bun" && rest[1] === "x") return argvKinds(rest.slice(2), depth)
  if (exe === "pnpm" && rest[1] === "exec") return argvKinds(rest.slice(2), depth)
  return toolKinds(exe, rest.slice(1))
}

/** Kinds of checks a shell command line actually invokes: the executable and its subcommand decide, never a mention. */
export function invokedKinds(line: string, depth = 0): InvokedKind[] {
  const kinds: InvokedKind[] = []
  for (const argv of shellSegments(line)) for (const kind of argvKinds(argv, depth)) if (!kinds.includes(kind)) kinds.push(kind)
  return kinds
}

const STRING_LITERAL = /"""[\s\S]*?"""|'''[\s\S]*?'''|`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g
const QUOTES = /^(?:"""|'''|[`'"])|(?:"""|'''|[`'"])$/g
const INTERPOLATION = /\$\{[^}]*\}|\{[A-Za-z_][\w.]*\}/g

/**
 * Check kinds run by shell strings inside eval cell code, with the offset of the first such string. Only string
 * literals are parsed as command lines, so prose, prints and grep patterns about a check never count; lookups are
 * dropped because cells grep and cat for many reasons besides proving existence.
 */
export function cellInvokedKinds(code: string): { kinds: Array<Exclude<InvokedKind, "lookup">>; offset: number } {
  const kinds: Array<Exclude<InvokedKind, "lookup">> = []
  let offset = -1
  for (const match of code.matchAll(STRING_LITERAL)) {
    const literal = match[0].replace(QUOTES, "").replace(INTERPOLATION, "X")
    const found = invokedKinds(literal).filter((kind): kind is Exclude<InvokedKind, "lookup"> => kind !== "lookup")
    if (found.length === 0) continue
    if (offset === -1) offset = match.index
    for (const kind of found) if (!kinds.includes(kind)) kinds.push(kind)
  }
  return { kinds, offset }
}
