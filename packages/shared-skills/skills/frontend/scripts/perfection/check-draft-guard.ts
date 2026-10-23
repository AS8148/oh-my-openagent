#!/usr/bin/env bun
// The draft guard in one command: accent stripes plus generated-look copy and markup (promo copy, emoji icons, hype badges, vanity stats).
// Usage: bun check-draft-guard.ts [--json] <file-or-dir>...   Exit 0 clean, 1 findings, 2 usage.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { RULE_MESSAGES } from "./accent-stripes/findings"
import { lintFiles, type SourceFile } from "./accent-stripes/lint"
import { DRAFT_RULE_MESSAGES } from "./draft-guard/findings"
import { lintDraft } from "./draft-guard/lint"

const SCANNED = /\.(?:css|scss|less|pcss|postcss|html?|[cm]?[jt]sx?|vue|svelte|astro)$/i
const SKIPPED_DIRS = new Set([
	"node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".astro",
	".turbo", ".cache", "coverage", "vendor", ".vercel", ".output",
])
const MAX_BYTES = 1_000_000
const MESSAGES: Readonly<Record<string, string>> = { ...RULE_MESSAGES, ...DRAFT_RULE_MESSAGES }

function collect(path: string, into: string[]): void {
	const stat = statSync(path)
	if (stat.isDirectory()) {
		for (const entry of readdirSync(path)) {
			if (!SKIPPED_DIRS.has(entry)) collect(join(path, entry), into)
		}
		return
	}
	const minified = /\.min\.[a-z]+$/i.test(path) || path.endsWith(".d.ts")
	if (SCANNED.test(path) && !minified && stat.size <= MAX_BYTES) into.push(path)
}

function main(argv: readonly string[]): number {
	const json = argv.includes("--json")
	const targets = argv.filter((a) => a !== "--json")
	if (targets.length === 0) {
		process.stderr.write("usage: check-draft-guard.ts [--json] <file-or-dir>...\n")
		return 2
	}
	const paths: string[] = []
	for (const target of targets) collect(target, paths)
	const files: SourceFile[] = paths.map((path) => ({ path, text: readFileSync(path, "utf8") }))
	const findings = [...lintFiles(files), ...lintDraft(files)].sort(
		(a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
	)
	if (json) process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`)
	else {
		for (const f of findings) {
			process.stdout.write(`${f.file}:${f.line}:${f.column}  ${f.rule}  ${MESSAGES[f.rule]}\n    > ${f.excerpt}\n`)
		}
		const summary = findings.length === 0 ? "clean" : `${findings.length} finding(s); fix each before visual QA`
		process.stdout.write(`check-draft-guard: ${paths.length} file(s), ${summary}\n`)
	}
	return findings.length === 0 ? 0 : 1
}

process.exitCode = main(process.argv.slice(2))
