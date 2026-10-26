// sources-citation.mjs - the one Sources predicate shared by the static, trace, and claim gates.
//
// Under a Sources heading an element is split at <br>/block breaks and at sentence ends. A segment
// is decided by the TYPE of its numbers and the SHAPE of its line, not by a verb list. Citation
// fields are removed first: URLs, DOIs, arXiv ids, citation tags, quoted titles ("...", \u201C...\u201D,
// \u300C...\u300D), and a title segment that sits between a citation lead and a URL or date. What is
// left is a claim when it holds a MEASURE number (percent, a currency symbol or code, a magnitude
// word, a unit or Korean counter, or a non-year decimal), a first-person cue from CLAIM_KINDS, or a
// claim verb next to a non-year number. Years, dates, pages, volume and issue numbers stay exempt.
// Pure; sibling imports only. Korean phrases are \u escapes.

import { unmarkedKinds } from "./claim-kinds.mjs"

const SKIP = new Set(["script", "style", "template"])
const BREAK = new Set(["br", "p", "li", "div", "tr", "dd", "dt"])
// Abbreviations whose period never ends a citation sentence: pp., p., vol., no., ed., eds., et al., J. (initials).
const NOT_END = /(?:\b(?:pp?|vol|vols|no|nos|ed|eds|al|ch|sec|fig|vs|e\.g|i\.e|[A-Z])\.)$/i
// Claim verbs: an extra trigger beside a non-year number, never the only test.
const EN_PREDICATE = /\b(?:rose|rises|risen|fell|falls|fallen|grew|grows|grown|increased|decreased|declined|dropped|doubled|tripled|halved|reached|says|said|stated|reported|showed|found|estimated|according\s+to)\b/i
// jeungga-haet, gamso-haet, sangseung-haet, harak-haet, neul-eot, jul-eot, dal-haet, chaji-haet, seongjang-haet, balk-hyeot, ttareumyeon.
const KO_PREDICATE = /\uC99D\uAC00\uD588|\uAC10\uC18C\uD588|\uC0C1\uC2B9\uD588|\uD558\uB77D\uD588|\uB298\uC5C8|\uC904\uC5C8|\uB2EC\uD588|\uCC28\uC9C0\uD588|\uC131\uC7A5\uD588|\uBC1D\uD614|\uB530\uB974\uBA74/
/** Citation fields: URLs, DOIs, arXiv ids, citation tags, quoted titles. */
const FIELDS = [/https?:\/\/\S+/gi, /\b10\.\d{4,9}\/\S+/g, /\b\d{4}\.\d{4,5}(?:v\d+)?\b/g, /\[(?:S|Source\s*)?\^?\d+\]/gi, /"[^"]*"/g, /\u201C[^\u201D]*\u201D/g, /\u300C[^\u300D]*\u300D/g]
const DATE = /\b(?:19|20)\d{2}(?:[-./]\d{1,2}(?:[-./]\d{1,2})?)?\b/
// Korean: percent (peosenteu), currency won/dollar/euro/yen, counters myeong/geon/gae/bae, scales cheon/man/eok/jo.
const MEASURE = [
	/\d\s?(?:%|\u2030|\uD37C\uC13C\uD2B8)/,
	/[$\u20AC\u00A3\u00A5\u20A9]\s?\d/,
	/\b(?:USD|KRW|EUR|JPY|GBP|CNY)\s?\d|\d\s?(?:USD|KRW|EUR|JPY|GBP|CNY|dollars?|won|euros?|yen)\b/i,
	/\d\s?(?:thousand|million|billion|trillion|bn)\b|\d(?:k|K|M|B)\b/,
	/\d\s?(?:\uC6D0|\uB2EC\uB7EC|\uC720\uB85C|\uC5D4|\uBA85|\uAC74|\uAC1C(?!\uC6D4)|\uBC30|[\uCC9C\uB9CC\uC5B5\uC870](?!\s?[\uB144\uC6D4]))/,
	/\d\s?(?:km|kg|mm|cm|ms|kWh|MWh|GWh|KB|MB|GB|TB|meters?|metres?|kilometers?|tons?|tonnes?|hours?|minutes?|seconds?|days?|users?|people|employees|customers?)\b/,
	/(?<![\d.,])(?!(?:19|20)\d{2}\.)\d+\.\d+(?![\d.])/,
]

/** A fact element is bound by its ledger row, not traced here; it reads as one opaque token. */
const isFact = (node) => node.attrs?.["data-fact"] !== undefined || node.attrs?.["data-translates"] !== undefined || node.tag === "q" || node.tag === "blockquote"
const FACT_TOKEN = "\u0000"
/** A link's text is its title, a citation field; the line keeps a marker that it carries a URL. */
const LINK_TOKEN = "\u0002"

function lines(node, out = [""]) {
	for (const child of node.children ?? []) {
		if (child.tag === "#text") out[out.length - 1] += child.text
		else if (SKIP.has(child.tag)) continue
		else if (isFact(child)) out[out.length - 1] += ` ${FACT_TOKEN} `
		else if (child.tag === "a" && /^https?:\/\//i.test(child.attrs?.href ?? "")) out[out.length - 1] += ` ${LINK_TOKEN} `
		else {
			if (BREAK.has(child.tag)) out.push("")
			lines(child, out)
			if (BREAK.has(child.tag)) out.push("")
		}
	}
	return out
}

/** Sentences of one line; a period after an abbreviation, an initial, or inside a number never ends one. */
function sentences(line) {
	const out = []
	let start = 0
	for (const match of line.matchAll(/[.!?](?=\s+\S|$)/g)) {
		const end = match.index + 1
		if (NOT_END.test(line.slice(start, end))) continue
		out.push(line.slice(start, end))
		start = end
	}
	out.push(line.slice(start))
	return out.map((text) => text.replace(/\s+/g, " ").trim()).filter(Boolean)
}

const stripFields = (text) => FIELDS.reduce((rest, re) => rest.replace(re, " "), text)
const onlyCitation = (text) => new RegExp(`https?://|${LINK_TOKEN}|\\b(?:accessed|retrieved)\\b`, "i").test(text) || (DATE.test(text) && !/\d/.test(stripFields(text).replace(new RegExp(DATE.source, "g"), " ")))

/** A segment reads as a claim, not a citation field. A tagged entry carrying a URL ("[S4] Title $5B: https://...") is a reference line. */
export function isClaimSegment(text) {
	if (unmarkedKinds(text).length > 0) return true
	if (/^\s*\[(?:S|Source\s*)?\^?\d+\]/i.test(text) && new RegExp(`https?://|${LINK_TOKEN}`, "i").test(text)) return false
	const rest = stripFields(text)
	if (MEASURE.some((re) => re.test(rest))) return true
	const nonYear = rest.replace(new RegExp(DATE.source, "g"), " ").replace(/\b(?:pp?|vol|no|issue|ch|sec)\.?\s*\d+(?:\s*[-\u2013/]\s*\d+)?/gi, " ")
	return /\d/.test(nonYear) && (EN_PREDICATE.test(rest) || KO_PREDICATE.test(rest))
}

/** Claim segments of one line; a title between a citation lead and a URL or date is a citation field. */
function lineClaims(line) {
	const segments = sentences(line)
	return segments.filter((segment, at) => !(at > 0 && at + 1 < segments.length && onlyCitation(segments[at + 1])) && isClaimSegment(segment)).map(stripFields)
}

/** The claim segments of an element under Sources ([] for a reference entry, a heading, or a citation cell). */
export function sourcesClaims(node) {
	if (/^h[1-6]$/.test(node.tag)) return []
	return lines(node).flatMap(lineClaims)
}

/** The claim segments of loose text (a text node owned by a container element rather than a prose element). */
export function textClaims(text) {
	return lines({ children: [{ tag: "#text", text }] }).flatMap(lineClaims)
}
