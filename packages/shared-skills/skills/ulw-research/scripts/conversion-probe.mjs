// conversion-probe.mjs - numeric multiset differences after source conversion.
// Inline markup may split one number; superscripts must not merge into it. Numbers are read with the
// one grouped-number grammar (number-grammar.mjs). A cell, row, list-item, block or line break is a
// hard boundary: a space never groups digits across it. A sign counts when no Latin, Greek or
// Cyrillic letter, digit or underscore touches it (an en dash before a digit is a minus too), and a
// "-" or U+2212 counts after ONE such letter ("\u0394\u22125") or after an exponent ("1e-5"); a run of
// two or more ("cite_note-7", "AB-12", "UTF-8", "2019-2023") is an identifier or range and carries no
// negative. Digits a converter writes out from a link target, an image source, alt text, or a title
// cover a converted number only inside Markdown link or image syntax (`](...)`, `![...](...)`,
// `<https://...>`, `[ref]: url`), never in prose. Converter syntax is not a number: a line-start list
// marker ("1. ", "2) ", "(3) ", indented or after "> ") is exempt only while the source has an <ol>
// item with that number (start= honoured, one item per marker), and a numeric reference label
// ("[x][1]" with its "[1]: url") only while both halves are present; otherwise each is a candidate.
// A converter's hard wrap may split a space-grouped number over one line break; the two halves read
// as one number only when the raw side holds that number and not both halves. The built-in snapshot
// writes no attribute text, syntax or wraps, so it gets none of these allowances.

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { CliError } from "./cli-support.mjs"
import { parseHtml, PROSE_BREAKS } from "./html-lite.mjs"
import { NUMBER_SOURCE, plainDecimal } from "./number-grammar.mjs"

const LETTER = "\\p{Script=Latin}\\p{Script=Greek}\\p{Script=Cyrillic}"
const SIGN = `(?<![${LETTER}\\p{N}_])[-\\u2212\\u2013]|(?<=(?<![${LETTER}\\p{N}_])[${LETTER}])[-\\u2212]|(?<=(?<![${LETTER}\\p{N}_.,])\\d+(?:[.,]\\d+)?[eE])[-\\u2212]`
const NUMBERS = new RegExp(`(${SIGN})?(${NUMBER_SOURCE})`, "gu")
/** Sup, sub, datetime chunks and every break join no neighbour: neither a digit, a separator, nor whitespace. */
const BOUNDARY = "\u0001"
const CARRIED = ["href", "src", "alt", "title"]
const LIST_MARKER = /(?:^|\u0001)(?: ?>)* ?(?:\d+[.)]|\(\d+\)) /gu
const REF_USE = /\]\[(\d+)\]/gu
const REF_DEF = /(?:^|\u0001)(?: ?>)* ?\[(\d+)\]:/gu
const LINK_SYNTAX = /!\[[^\]\u0001]*\](?:\([^)\u0001]*\))?|\]\([^)\u0001]*\)|<https?:\/\/[^>\s\u0001]+>|(?:^|\u0001) ?\[[^\]\u0001]+\]:[^\u0001]*/gu

/** Prose text, attribute text and <ol> item numbers of an HTML document; a non-HTML document is prose only. */
function numericText(source, html) {
	if (!html) return { prose: source, carried: "", listed: [] }
	const chunks = []
	const carried = []
	const listed = []
	const walk = (node) => {
		if (node.tag === "#text") { chunks.push(node.text.replace(/\s+/gu, " ")); return }
		for (const name of CARRIED) if (node.attrs?.[name] !== undefined) carried.push(node.attrs[name])
		if (node.tag === "ol") {
			const start = /^\s*\d+\s*$/u.test(node.attrs.start ?? "") ? Number(node.attrs.start) : 1
			node.children.filter((child) => child.tag === "li").forEach((_, index) => listed.push(String(start + index)))
		}
		const edge = node.tag === "sup" || node.tag === "sub" || PROSE_BREAKS.has(node.tag) ? BOUNDARY : ""
		chunks.push(edge)
		if (node.tag === "time" && node.attrs.datetime !== undefined) chunks.push(`${BOUNDARY}${node.attrs.datetime}${BOUNDARY}`)
		for (const child of node.children) walk(child)
		chunks.push(edge)
	}
	walk(parseHtml(source))
	return { prose: chunks.join(""), carried: carried.join(BOUNDARY), listed }
}

/** Start offsets of numeric reference labels whose use ("][1]") and definition ("[1]:") are both present. */
function referenceLabels(flat) {
	const uses = [...flat.matchAll(REF_USE)]
	const defs = [...flat.matchAll(REF_DEF)]
	const used = new Set(uses.map((match) => match[1]))
	const defined = new Set(defs.map((match) => match[1]))
	const paired = [...uses.filter((match) => defined.has(match[1])), ...defs.filter((match) => used.has(match[1]))]
	return new Set(paired.map((match) => match.index + match[0].lastIndexOf("[") + 1))
}

/**
 * Line breaks become boundaries, then whitespace runs one space; `linked` marks tokens inside link
 * syntax, `marker` a line-start list marker, `label` a paired reference label, `gap` the text since
 * the previous number.
 */
function tokensOf(text, { links = false } = {}) {
	const flat = text.replace(/\r\n?|\n|\f/gu, BOUNDARY).replace(/\s+/gu, " ")
	const spans = links ? [...flat.matchAll(LINK_SYNTAX)].map((match) => [match.index, match.index + match[0].length]) : []
	const markers = new Set([...flat.matchAll(LIST_MARKER)].map((match) => match.index + match[0].search(/\d/u)))
	const labels = referenceLabels(flat)
	let previousEnd = 0
	return [...flat.matchAll(NUMBERS)].map((match, n) => {
		const gap = flat.slice(previousEnd, match.index)
		previousEnd = match.index + match[0].length
		return {
			n,
			gap,
			text: match[0],
			key: `${match[1] ? "-" : ""}${plainDecimal(match[2])}`,
			linked: spans.some(([start, end]) => match.index >= start && match.index < end),
			marker: markers.has(match.index),
			label: labels.has(match.index),
		}
	})
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

/** Rejoin a grouped number a hard wrap split over one line break, when only the joined reading is in the raw counts. */
function joinWrapped(tokens, raw) {
	const out = []
	for (const token of tokens) {
		const prev = out.at(-1)
		const wrapped = prev?.n === token.n - 1 && /^ ?\u0001 ?$/u.test(token.gap) && !prev.linked && !token.linked
		const [joined, ...more] = wrapped ? tokensOf(`${prev.text} ${token.text}`) : []
		if (joined && more.length === 0 && raw.has(joined.key) && !(raw.has(prev.key) && raw.has(token.key))) {
			out[out.length - 1] = { ...joined, n: token.n, text: `${prev.text}\n${token.text}` }
			continue
		}
		out.push(token)
	}
	return out
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
 * (the built-in snapshot) gives attribute digits no cover, converter syntax no exemption and no wrap rejoin. An exempt
 * marker or label is not a converted number at all: it neither covers a raw number nor counts as altered.
 */
export function probeConversion(raw, converted, { attributes = true } = {}) {
	const source = numericText(raw, /<[a-z!/]/i.test(raw))
	const before = tokensOf(source.prose)
	const items = countOf(attributes ? source.listed.map((key) => ({ key })) : [])
	const syntax = tokensOf(converted, { links: attributes })
		.filter((token) => !(attributes && token.label) && (!token.marker || uncovered([token], items).length > 0))
	const after = attributes ? joinWrapped(syntax, countOf(before)) : syntax
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
