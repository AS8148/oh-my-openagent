// conversion-probe.mjs - numeric multiset differences after source conversion.
// Inline markup may split one number; superscripts must not merge into it. Numbers are read with the
// one grouped-number grammar (number-grammar.mjs). A sign counts only when no letter or digit touches
// it ("cite_note-7" and "2019-2023" carry no negative). Digits a converter writes out from a link
// target, an image source, alt text, or a title may appear in the converted text, but are never lost.

import { readFileSync } from "node:fs"

import { CliError } from "./cli-support.mjs"
import { parseHtml, PROSE_BREAKS } from "./html-lite.mjs"
import { NUMBER_SOURCE, plainDecimal } from "./number-grammar.mjs"

const NUMBERS = new RegExp(`((?<![\\p{L}\\p{N}])[-\\u2212])?(${NUMBER_SOURCE})`, "gu")
/** Sup, sub, and datetime chunks join no neighbour: a boundary that is neither a digit, a separator, nor whitespace. */
const BOUNDARY = "\u0001"
const CARRIED = ["href", "src", "alt", "title"]

/** Prose text and attribute text of an HTML document; a non-HTML document is prose only. */
function numericText(source, html) {
	if (!html) return { prose: source, carried: "" }
	const chunks = []
	const carried = []
	const walk = (node) => {
		if (node.tag === "#text") { chunks.push(node.text); return }
		for (const name of CARRIED) if (node.attrs?.[name] !== undefined) carried.push(node.attrs[name])
		const sup = node.tag === "sup" || node.tag === "sub"
		const edge = sup ? BOUNDARY : PROSE_BREAKS.has(node.tag) ? " " : ""
		chunks.push(edge)
		if (node.tag === "time" && node.attrs.datetime !== undefined) chunks.push(`${BOUNDARY}${node.attrs.datetime}${BOUNDARY}`)
		for (const child of node.children) walk(child)
		chunks.push(edge)
	}
	walk(parseHtml(source))
	return { prose: chunks.join(""), carried: carried.join(" ") }
}

function tokensOf(text) {
	return [...text.replace(/\s+/gu, " ").matchAll(NUMBERS)].map((match) => ({ text: match[0], key: `${match[1] ? "-" : ""}${plainDecimal(match[2])}` }))
}

/** The comparison key of one number token, so other tools can match a converted number against a probe record. */
export const numberKey = (token) => tokensOf(String(token))[0]?.key ?? null

/** The numbers in `texts` that the snapshot's conversion probe recorded as altered (conversion.json). */
export function alteredIn(altered, texts) {
	const keys = new Set(altered.map(numberKey))
	return texts.flatMap((text) => tokensOf(String(text ?? ""))).filter((token) => keys.has(token.key)).map((token) => token.text)
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

/** Preserve token spelling in diagnostics; only the raw side is ever read as HTML. */
export function probeConversion(raw, converted) {
	const source = numericText(raw, /<[a-z!/]/i.test(raw))
	const before = tokensOf(source.prose)
	const allowed = [...before, ...tokensOf(source.carried)]
	const after = tokensOf(converted)
	return { altered: difference(after, allowed), lost: difference(before, after), raw_count: before.length, converted_count: after.length }
}

export function runConversionProbe(argv) {
	if (argv.length !== 2) throw new CliError("usage: source probe-conversion <raw-file> <converted-file>")
	const result = probeConversion(readFileSync(argv[0], "utf8"), readFileSync(argv[1], "utf8"))
	return { json: result, summary: `source probe-conversion: ${result.altered.length} altered, ${result.lost.length} lost`, exitCode: result.altered.length === 0 ? 0 : 1 }
}
