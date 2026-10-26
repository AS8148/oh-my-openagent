// conversion-probe.mjs - numeric multiset differences after source conversion.
// Inline markup may split one number; superscripts must not merge into it. Numbers are read with the
// one grouped-number grammar (number-grammar.mjs). A cell, row, list-item, block or line break is a
// hard boundary: a space never groups digits across it. A sign counts only when no Latin, Greek or
// Cyrillic letter, digit or underscore touches it ("cite_note-7" and "2019-2023" carry no negative);
// an en dash before a digit is a minus too. Digits a converter writes out from a link target, an
// image source, alt text, or a title cover a converted number only inside Markdown link or image
// syntax (`](...)`, `![...](...)`, `<https://...>`, `[ref]: url`), never in prose; the built-in snapshot
// writes no attribute text, so it gets no such allowance.

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { CliError } from "./cli-support.mjs"
import { parseHtml, PROSE_BREAKS } from "./html-lite.mjs"
import { NUMBER_SOURCE, plainDecimal } from "./number-grammar.mjs"

const NUMBERS = new RegExp(`((?<![\\p{Script=Latin}\\p{Script=Greek}\\p{Script=Cyrillic}\\p{N}_])[-\\u2212\\u2013])?(${NUMBER_SOURCE})`, "gu")
/** Sup, sub, datetime chunks and every break join no neighbour: neither a digit, a separator, nor whitespace. */
const BOUNDARY = "\u0001"
const CARRIED = ["href", "src", "alt", "title"]
const LINK_SYNTAX = /!\[[^\]\u0001]*\](?:\([^)\u0001]*\))?|\]\([^)\u0001]*\)|<https?:\/\/[^>\s\u0001]+>|(?:^|\u0001) ?\[[^\]\u0001]+\]:[^\u0001]*/gu

/** Prose text and attribute text of an HTML document; a non-HTML document is prose only. */
function numericText(source, html) {
	if (!html) return { prose: source, carried: "" }
	const chunks = []
	const carried = []
	const walk = (node) => {
		if (node.tag === "#text") { chunks.push(node.text.replace(/\s+/gu, " ")); return }
		for (const name of CARRIED) if (node.attrs?.[name] !== undefined) carried.push(node.attrs[name])
		const edge = node.tag === "sup" || node.tag === "sub" || PROSE_BREAKS.has(node.tag) ? BOUNDARY : ""
		chunks.push(edge)
		if (node.tag === "time" && node.attrs.datetime !== undefined) chunks.push(`${BOUNDARY}${node.attrs.datetime}${BOUNDARY}`)
		for (const child of node.children) walk(child)
		chunks.push(edge)
	}
	walk(parseHtml(source))
	return { prose: chunks.join(""), carried: carried.join(BOUNDARY) }
}

/** Line breaks become boundaries, then whitespace runs one space; `linked` marks tokens inside link syntax. */
function tokensOf(text, { links = false } = {}) {
	const flat = text.replace(/\r\n?|\n|\f/gu, BOUNDARY).replace(/\s+/gu, " ")
	const spans = links ? [...flat.matchAll(LINK_SYNTAX)].map((match) => [match.index, match.index + match[0].length]) : []
	return [...flat.matchAll(NUMBERS)].map((match) => ({
		text: match[0],
		key: `${match[1] ? "-" : ""}${plainDecimal(match[2])}`,
		linked: spans.some(([start, end]) => match.index >= start && match.index < end),
	}))
}

/** The comparison key of one number token, so other tools can match a converted number against a probe record. */
export const numberKey = (token) => tokensOf(String(token))[0]?.key ?? null

/** The numbers in `texts` that the source's conversion probe recorded as altered (sources/<id>/conversion.json). */
export function alteredIn(sourceDir, texts) {
	const record = join(sourceDir, "conversion.json")
	let altered = []
	if (existsSync(record)) {
		try {
			altered = JSON.parse(readFileSync(record, "utf8")).conversion_altered_numbers ?? []
		} catch (error) {
			throw new CliError(`${record} is not a readable conversion record (${error.message}); snapshot the source again`)
		}
	}
	const keys = new Set(altered.map(numberKey))
	return texts.flatMap((text) => tokensOf(String(text ?? ""))).filter((token) => keys.has(token.key)).map((token) => token.text)
}

const countOf = (tokens) => tokens.reduce((counts, token) => counts.set(token.key, (counts.get(token.key) ?? 0) + 1), new Map())

/** The tokens `counts` cannot cover; each covered token uses up one count. */
function uncovered(tokens, counts) {
	return tokens.filter((token) => {
		const remaining = counts.get(token.key) ?? 0
		if (remaining === 0) return true
		counts.set(token.key, remaining - 1)
		return false
	})
}

/**
 * Preserve token spelling in diagnostics; only the raw side is ever read as HTML. `attributes: false`
 * (the built-in snapshot) gives attribute digits no cover at all.
 */
export function probeConversion(raw, converted, { attributes = true } = {}) {
	const source = numericText(raw, /<[a-z!/]/i.test(raw))
	const before = tokensOf(source.prose)
	const after = tokensOf(converted, { links: attributes })
	const counts = countOf(before)
	const extra = new Set(uncovered(after.filter((token) => !token.linked), counts))
	for (const token of tokensOf(source.carried)) counts.set(token.key, (counts.get(token.key) ?? 0) + 1)
	for (const token of uncovered(after.filter((token) => token.linked), counts)) extra.add(token)
	const lost = uncovered(before, countOf(after)).map((token) => token.text)
	return { altered: after.filter((token) => extra.has(token)).map((token) => token.text), lost, raw_count: before.length, converted_count: after.length }
}

export function runConversionProbe(argv) {
	if (argv.length !== 2) throw new CliError("usage: source probe-conversion <raw-file> <converted-file>")
	const result = probeConversion(readFileSync(argv[0], "utf8"), readFileSync(argv[1], "utf8"))
	return { json: result, summary: `source probe-conversion: ${result.altered.length} altered, ${result.lost.length} lost`, exitCode: result.altered.length === 0 ? 0 : 1 }
}
