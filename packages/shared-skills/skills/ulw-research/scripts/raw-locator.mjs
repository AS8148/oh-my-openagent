// Raw byte locators and exact, context-bound re-anchoring. value_span remains quote-relative text.

import { parseNumeral } from "./numerals.mjs"

const byteAt = (text, offset) => Buffer.byteLength(text.slice(0, offset), "utf8")
const chars = (text) => [...text]

/** Context is copied before normalization, around the value (or the whole quote for Q rows). */
export function quoteContext(text, start, end) {
	return { prefix: chars(text.slice(0, start)).slice(-32).join(""), suffix: chars(text.slice(end)).slice(0, 32).join("") }
}

/** Convert the locator produced by the text parser, not the quote-relative value_span. */
export function rawLocated(text, found) {
	if (found.error) return found
	const { char_start: start, char_end: end } = found.locator
	const from = start + (found.value_span?.[0] ?? 0)
	const to = found.value_span ? start + found.value_span[1] : end
	return {
		...found,
		context: quoteContext(text, from, to),
		locator: { ...found.locator, artifact: "raw.bin", unit: "utf8-bytes", char_start: byteAt(text, start), char_end: byteAt(text, end) },
	}
}

/** Map a labeled table cell's parsed quantity back to raw text nodes, never attribute values. */
export function rawTableLocated(source, cell, found) {
	const hits = []
	const walk = (node) => {
		if (node.tag === "#text") {
			const body = source.slice(node.source_start, node.source_end)
			for (let numeral = parseNumeral(body); numeral; numeral = parseNumeral(body, numeral.span[1])) {
				if (numeral.value === found.value) hits.push({ start: node.source_start + numeral.span[0], end: node.source_start + numeral.span[1] })
			}
		} else for (const child of node.children) walk(child)
	}
	walk(cell)
	if (hits.length !== 1) return { error: hits.length ? "fact_ambiguous" : "fact_not_located", candidates: hits }
	const { start, end } = hits[0]
	return {
		...found,
		raw: source.slice(start, end),
		quote: source.slice(cell.source_start, cell.source_end),
		value_span: [start - cell.source_start, end - cell.source_start],
		locator: { ...found.locator, char_start: cell.source_start, char_end: cell.source_end },
	}
}

function contextMatches(raw, row, start, end) {
	if (!row.context) return false
	const quote = row.quote
	const from = row.value_span ? start + byteAt(quote, row.value_span[0]) : start
	const to = row.value_span ? start + byteAt(quote, row.value_span[1]) : end
	const prefix = Buffer.from(row.context.prefix)
	const suffix = Buffer.from(row.context.suffix)
	return from >= prefix.length && raw.subarray(from - prefix.length, from).equals(prefix) && raw.subarray(to, to + suffix.length).equals(suffix)
}

/** An unchanged range, exactly one relocated range, or null. Never rewrites the pinned row. */
export function reanchor(raw, row) {
	const quote = Buffer.from(row.quote)
	const { char_start: start, char_end: end } = row.locator
	if (quote.length === 0) return null
	if (raw.subarray(start, end).equals(quote)) return { start, end, relocated: false }
	const hits = []
	for (let from = 0; from <= raw.length - quote.length; ) {
		const at = raw.indexOf(quote, from)
		if (at === -1) break
		if (contextMatches(raw, row, at, at + quote.length)) hits.push(at)
		if (hits.length > 1) return null
		from = at + 1
	}
	return hits.length === 1 ? { start: hits[0], end: hits[0] + quote.length, relocated: true } : null
}
