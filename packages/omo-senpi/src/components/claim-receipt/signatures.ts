import type { CheckKind, CheckOutcome } from "./evidence"

const COMMAND_KINDS: ReadonlyArray<readonly [Exclude<CheckKind, "lsp">, RegExp]> = [
  ["test", /\b(?:bun (?:run )?test|vitest|jest|pytest|cargo test|go test|deno test|playwright test|(?:npm|pnpm|yarn) (?:run )?test|test:[\w:-]+|gh pr checks|vp test|vp run\b[^\n`'"]*?\stest)\b/],
  ["typecheck", /\b(?:tsc|tsgo|typecheck|type-check|mypy|pyright|cargo check|vp check)\b/],
  ["lint", /\b(?:biome|eslint|oxlint|ruff|clippy|lint|vp check)\b/],
  ["build", /\b(?:bun build|cargo build|go build|vite build|next build|(?:bun|npm|pnpm|yarn) run build(?::[\w:-]+)?|build:[\w:-]+)\b/],
  ["run", /\bscripts\/qa\/|\b(?:qa|e2e)-?(?:driver|run)\b/],
]

export function commandKinds(command: string): Array<Exclude<CheckKind, "lsp">> {
  return COMMAND_KINDS.filter(([, pattern]) => pattern.test(command)).map(([kind]) => kind)
}

export function firstCommandOffset(code: string): number {
  let first = -1
  for (const [, pattern] of COMMAND_KINDS) {
    const match = pattern.exec(code)
    if (match !== null && (first === -1 || match.index < first)) first = match.index
  }
  return first
}

const FAIL_SIGNATURES: readonly RegExp[] = [
  /(?<![0-9])[1-9]\d*\s+fail(?:ed|ures?)?\b/i,
  /^\(fail\)/m,
  /\bFAIL\b/,
  /\berror TS\d+/,
  /AssertionError/,
  /^\s*error(?:\[[^\]]*\])?:/im,
  /\b[A-Z_]*EXIT[=:]\s*[1-9]\d*\b/,
  /\bexit(?:ed)?(?: with)?(?: code| status)?\s*[:=]?\s*[1-9]\d*\b/i,
  /\bTests?:?\s+[1-9]\d* failed/,
  /\bTest Files\s+[1-9]\d* failed/,
  /"exitCode":\s*[1-9]/,
  /\bFound [1-9]\d* errors?\b/,
  /Files with errors:\s*[1-9]/,
  /\tfail\t/,
]

const UNSETTLED_SIGNATURES: readonly RegExp[] = [/\t(?:pending|queued|in_progress)\t/]

const PASS_SIGNATURES: readonly RegExp[] = [
  /(?<![0-9])0\s+fail(?:ed|ures?)?\b/i,
  /(?<![0-9])[1-9]\d*\s+pass(?:ed)?\b/i,
  /\bTests?:?\s+\d+ passed/,
  /\bTest Files\s+\d+ passed/,
  /"exitCode":\s*0\b/,
  /\bAll tests passed\b/i,
  /\b[A-Z_]*EXIT[=:]\s*0\b/,
  /\bexit(?:ed)?(?: with)?(?: code| status)?\s*[:=]?\s*0\b/i,
  /\bFound 0 errors\b/,
  /\bNo diagnostics found\b/,
  /Files with errors:\s*0\b/,
  /\bNo fixes applied\b/,
  /\tpass\t/,
]

export function judgeOutput(text: string): CheckOutcome {
  if (FAIL_SIGNATURES.some((pattern) => pattern.test(text))) return "failed"
  if (UNSETTLED_SIGNATURES.some((pattern) => pattern.test(text))) return "unknown"
  if (PASS_SIGNATURES.some((pattern) => pattern.test(text))) return "passed"
  return "unknown"
}

const NON_CODE_PATH = /(?:^|\/)(?:\.omo|tmp|evidence|notepads?)\/|^\/(?:private\/)?tmp\/|\.(?:md|txt|log|jsonl|csv)$/i

export function isRelevantPath(path: string): boolean {
  return !NON_CODE_PATH.test(path)
}
