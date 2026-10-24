// polish-project.mjs - the protected projection of report markup that every polish check compares.
//
// project(markup) yields the ordered fact spans {id, html}, the visible text, the masked text (each
// fact span replaced by SLOT) and the ordered href / data-claim values. Callers pass markup already
// reduced by html-visible.visibleMarkup, so hidden content never counts as present. Fact spans are
// the placeholder.mjs FACT_ELEMENT_TAGS elements carrying data-fact (any quoting). Hedge and
// qualifier terms come from fidelity-lexicon (guardedTerms, lexicalPattern "guard" mode).
// No IO, no model. Plain Node ESM.

import { decodeEntities } from "./entities.mjs"
import { guardedTerms, lexicalPattern, QUALIFIER_FORMS } from "./fidelity-lexicon.mjs"
import { tagAttributes } from "./html-visible.mjs"
import { HEDGES } from "./lexicon.mjs"
import { parseNumeral } from "./numerals.mjs"
import { FACT_ELEMENT_TAGS } from "./placeholder.mjs"
import { splitSentences } from "./sentence-split.mjs"
import { normalizeUnit } from "./units.mjs"

/** The attributes whose values a polish edit must keep, in order. */
export const POLISH_LINK_ATTRIBUTES = Object.freeze(["href", "data-claim"])
/** The bare digit runs compared outside fact spans when no quantity parses around them. */
export const POLISH_DIGITS = /\d+(?:[.,]\d+)*/g
/** Stands in for one fact span in masked text; a private-use char, so no numeral or word matches it. */
export const SLOT = "\uE000"
const FACT_SPAN = new RegExp(
	`<(${FACT_ELEMENT_TAGS.join("|")})\\b[^>]*?\\sdata-fact\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^\\s"'>]+))[^>]*>[\\s\\S]*?<\\/\\1\\s*>`,
	"gi",
)

/** Each fact span of the markup as {id, start, end, html}, in order. */
export function factSpans(markup) {
	return [...String(markup).matchAll(FACT_SPAN)].map((m) => ({ id: m[2] ?? m[3] ?? m[4], start: m.index, end: m.index + m[0].length, html: m[0] }))
}

/** Visible text of an HTML fragment: tags become spaces, entities decoded, whitespace collapsed. */
export function textOf(html) {
	return decodeEntities(html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ")
}

/** The protected projection of (already visible) markup; see the header. */
export function project(markup) {
	const facts = []
	let visible = ""
	let masked = ""
	let at = 0
	for (const span of factSpans(markup)) {
		const outside = textOf(markup.slice(at, span.start))
		facts.push({ id: span.id, html: span.html.replace(/\s+/g, " ") })
		visible += `${outside}${textOf(span.html)}`
		masked += `${outside} ${SLOT} `
		at = span.end
	}
	const rest = textOf(markup.slice(at))
	const links = tagAttributes(markup).flatMap(({ attrs }) =>
		POLISH_LINK_ATTRIBUTES.filter((name) => Object.hasOwn(attrs, name)).map((name) => `${name}=${attrs[name]}`),
	)
	return { facts, visible: (visible + rest).replace(/\s+/g, " ").trim(), masked: (masked + rest).replace(/\s+/g, " ").trim(), links }
}

const unitKey = (raw) => (raw === null ? "" : (normalizeUnit(raw) ?? raw.toLowerCase()))

/** Ordered numeral keys: a parsed quantity as "value unit" (once), any other digit run as written. */
export function numeralKeys(text) {
	const quantities = []
	for (let found = parseNumeral(text); found !== null; found = parseNumeral(text, found.span[1])) quantities.push(found)
	const keys = []
	let k = 0
	for (const match of text.matchAll(POLISH_DIGITS)) {
		while (k < quantities.length && quantities[k].span[1] <= match.index) k++
		const quantity = quantities[k]
		if (!quantity || quantity.span[0] > match.index) keys.push(match[0])
		else if (!quantity.counted) {
			quantity.counted = true
			keys.push(`${quantity.value}${quantity.range ? `~${quantity.valueEnd}` : ""} ${unitKey(quantity.unitRaw)}`.trim())
		}
	}
	return keys
}

/** term -> occurrence count of each listed term in the text (guard mode of the lexical engine). */
export function termCounts(text, terms = guardedTerms()) {
	const counts = new Map()
	for (const term of terms) {
		const n = [...text.matchAll(lexicalPattern(term, "guard"))].length
		if (n > 0) counts.set(term, n)
	}
	return counts
}

const add = (into, term, n) => into.set(term, (into.get(term) ?? 0) + n)

/**
 * The hedge and qualifier tokens the text before a polish holds and must keep (term -> count), per
 * sentence of the masked text: a sentence without fact spans keeps all its guarded tokens; a
 * sentence with fact spans keeps those of its tokens that the referenced rows' quote hedges or
 * qualifier forms name. A ledger term the sentence never held is never required.
 */
export function requiredTerms(projection, rows) {
	const required = new Map()
	let cursor = 0
	for (const { text } of splitSentences(projection.masked)) {
		const slots = text.split(SLOT).length - 1
		const facts = projection.facts.slice(cursor, cursor + slots)
		cursor += slots
		const present = termCounts(text)
		const sourced = new Set()
		for (const { id } of facts) {
			const row = rows.get(id)
			for (const term of termCounts(row?.quote ?? "", HEDGES).keys()) sourced.add(term)
			for (const form of QUALIFIER_FORMS[row?.qualifier] ?? []) sourced.add(form)
		}
		for (const [term, n] of present) if (slots === 0 || sourced.has(term)) add(required, term, n)
	}
	return required
}

/** Required terms the text no longer holds as many times, as "term" names. */
export function missingTerms(required, text) {
	const have = termCounts(text, [...required.keys()])
	return [...required].filter(([term, n]) => (have.get(term) ?? 0) < n).map(([term]) => term)
}
