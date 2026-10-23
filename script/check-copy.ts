import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import ts from "@typescript/typescript6"

const MESSAGE = "No em dashes in product copy. Use a period, comma, colon, or parentheses instead."

// These embedded directives and runtime bundles are generated from source outside this check's scope.
const GENERATED_SOURCES = new Set([
  "packages/omo-codex/plugin/components/ultrawork/src/directive-content.ts",
  "packages/omo-senpi/src/components/ultrawork/generated-directive.ts",
])

export function isProductSource(path: string): boolean {
  return /\.[cm]?[jt]sx?$/.test(path)
    && /^(?:(?:src|app|lib|workers|bin)\/|packages\/[^/]+\/(?:src|app|lib|components|i18n|plugin)\/|packages\/omo-native\/bin\/)/.test(path)
    && !/(?:^|\/)(?:__tests__|tests?|testkit|fixtures|testUtils|_generated|vendor|vendored|upstreams|node_modules|dist|scripts)(?:\/|$)/.test(path)
    && !/\.(?:test|spec|testkit|gen|generated)\.|\.d\.[cm]?ts$/.test(path)
    && !/(?:^|\/)testUtils\.[cm]?[jt]sx?$/.test(path)
    && !/^packages\/(?:lsp-daemon|lsp-tools-mcp)\//.test(path)
    && !/^packages\/omo-senpi\/plugin\/(?:extensions|runtime)\//.test(path)
    && !GENERATED_SOURCES.has(path)
}

export function findEmDashCopy(content: string, path: string): { line: number; column: number }[] {
  if (!isProductSource(path)) return []
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true)
  const hits: { line: number; column: number }[] = []
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node)
      || ts.isTemplateTail(node) || ts.isJsxText(node)) && node.text.includes("\u2014")) {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source))
      hits.push({ line: position.line + 1, column: position.character + 1 })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return hits
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..")
  const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }).split("\0").filter(isProductSource)
  let count = 0
  for (const path of new Set(paths)) {
    for (const hit of findEmDashCopy(readFileSync(resolve(root, path), "utf8"), path)) {
      console.error(`${path}:${hit.line}:${hit.column}: ${MESSAGE}`)
      count += 1
    }
  }
  console.log(`check:copy: ${count} violation(s)`)
  process.exitCode = count > 0 ? 1 : 0
}
