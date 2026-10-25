// conversion-probe.mjs - numeric multiset differences after source conversion.
// Inline markup may split one number; superscripts must not merge into it.

import { readFileSync } from "node:fs"

import { CliError } from "./cli-support.mjs"
import { parseHtml, PROSE_BREAKS } from "./html-lite.mjs"

const NUMBERS = /([+-]?\d+)((?:[,.\u0020\u202f\u00a0]\d{3})*)([.,]\d+)?/g
const SEPARATORS = /[,.\u0020\u202f\u00a0]/g

function numericText(source) {
	if (!/<[a-z!/]/i.test(source)) return source
	const chunks = []
	const walk = (node) => {
		if (node.tag === "#text") { chunks.push(node.text); return }
		const boundary = PROSE_BREAKS.has(node.tag) || node.tag === "sup" || node.tag === "sub"
		if (boundary) chunks.push("\n")
		if (node.tag === "time" && node.attrs.datetime !== undefined) chunks.push(`\n${node.attrs.datetime}\n`)
		for (const child of node.children) walk(child)
		if (boundary) chunks.push("\n")
	}
	walk(parseHtml(source))
	return chunks.join("")
}

function tokensOf(source) {
	return [...numericText(source).matchAll(NUMBERS)].map((match) => ({
		text: match[0],
		key: `${match[1]}${match[2].replace(SEPARATORS, "")}${(match[3] ?? "").replace(",", ".")}`,
	}))
}

function difference(tokens, baseline) {
	const counts = new Map()
	for (const token of baseline) counts.set(token.key, (counts.get(token.key) ?? 0) + 1)
	return tokens.filter((token) => {
		const remaining = counts.get(token.key) ?? 0
		if (remaining === 0) return true
		counts.set(token.key, remaining - 1)
		return false
	}).map((token) => token.text)
}

/** Preserve token spelling in diagnostics; normalize grouping separators only for comparison. */
export function probeConversion(raw, converted) {
	const before = tokensOf(raw)
	const after = tokensOf(converted)
	return { altered: difference(after, before), lost: difference(before, after), raw_count: before.length, converted_count: after.length }
}

export function runConversionProbe(argv) {
	if (argv.length !== 2) throw new CliError("usage: source probe-conversion <raw-file> <converted-file>")
	const result = probeConversion(readFileSync(argv[0], "utf8"), readFileSync(argv[1], "utf8"))
	return { json: result, summary: `source probe-conversion: ${result.altered.length} altered, ${result.lost.length} lost`, exitCode: result.altered.length === 0 ? 0 : 1 }
}
