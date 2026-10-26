// sources-citation.mjs - the one Sources predicate shared by the static, trace, and claim gates.
//
// Under a Sources heading an element is split at <br>/block breaks and at sentence ends, and every
// sentence holding a numeral is checked exactly as under any other heading, unless EVERY numeral in
// it is a citation-field number. That is decided by the number's type and position only: a year
// (1900-2099) or a full date; a page, volume, issue, number, or edition marker; a number inside a
// URL, DOI, arXiv id, ISBN or ISSN; a number inside a quoted title ("...", \u201C...\u201D, \u300C...\u300D,
// \u300E...\u300F, <cite>) or an <i>/<em> title directly before a URL or a date; or a citation tag's
// digits. There is no word list: any other numeral makes the sentence a claim. Pure; no imports.
// Korean markers are \u escapes.

const SKIP = new Set(["script", "style", "template"])
const BREAK = new Set(["br", "p", "li", "div", "tr", "dd", "dt"])
// Abbreviations whose period never ends a citation sentence: pp., p., vol., no., ed., eds., et al., J. (initials).
const NOT_END = /(?:\b(?:pp?|vol|vols|no|nos|ed|eds|al|ch|sec|fig|vs|e\.g|i\.e|[A-Z])\.)$/i
const FACT = "\u0000"
const LINK = "\u0002"
const [CITE_OPEN, CITE_CLOSE, EM_OPEN, EM_CLOSE] = ["\u0003", "\u0004", "\u0005", "\u0006"]
const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b\\.?"
const YEAR = "(?:19|20)\\d{2}"
const URL = `(?:https?://|www\\.)[^\\s<>"${LINK}]+?(?=[.,;:)\\]]?(?:\\s|$))`
/** A date at the start of a string: ISO/dotted/slashed, month-name, or Korean nyeon-wol-il. */
const DATE_AHEAD = new RegExp(`^(?:${YEAR}[-./]\\d{1,2}(?:[-./]\\d{1,2})?|\\d{1,2}[-./]\\d{1,2}[-./]${YEAR}|${MONTH}\\s+\\d{1,2},?\\s+${YEAR}|\\d{1,2}\\s+${MONTH}\\s+${YEAR}|${MONTH}\\s+${YEAR}|${YEAR}\\s*\\uB144|${YEAR}\\b)`, "i")
/** Citation-field spans, by type and position. */
const FIELDS = [
	new RegExp(URL, "gi"),
	/\b(?:doi:\s*)?10\.\d{4,9}\/[^\s<>"]+/gi,
	/\b(?:arXiv:\s*)?\d{4}\.\d{4,5}(?:v\d+)?\b/gi,
	/\bIS[BS]N(?:-1[03])?:?\s*[\dXx][\dXx\s-]{6,16}[\dXx]/g,
	/\[(?:S|Source\s*)?\^?\d+\]/gi,
	/"[^"]*"|\u201C[^\u201D]*\u201D|\u300C[^\u300D]*\u300D|\u300E[^\u300F]*\u300F/g,
	new RegExp(`${CITE_OPEN}[^${CITE_CLOSE}]*${CITE_CLOSE}`, "g"),
	new RegExp(`${YEAR}[-./]\\d{1,2}(?:[-./]\\d{1,2})?|\\d{1,2}[-./]\\d{1,2}[-./]${YEAR}`, "g"),
	new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s+${YEAR})?|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}`, "gi"),
	/\d{1,2}\s*\uC6D4(?:\s*\d{1,2}\s*\uC77C)?/g,
	new RegExp(`(?<![\\d.,])${YEAR}(?:\\s*[-\\u2013~]\\s*${YEAR})?(?![\\d]|[.,]\\d)`, "g"),
	/\b(?:pp?|pg|pages?)\.?\s*\d+(?:\s*[-\u2013]\s*\d+)?/gi,
	/\b(?:vols?|nos?|iss|ed)\.\s*\d+(?:\s*[-\u2013/]\s*\d+)*/gi,
	/\b(?:Vol|Volume|No|Issue|Number|volume|issue)\s+\d+(?:\s*[-\u2013/]\s*\d+)*/g,
	/\b\d+(?:st|nd|rd|th)\s+(?:ed\.|edition)|\bedition\s+\d+/gi,
	/\uC81C?\s*\d+(?:\s*[-\u2013~]\s*\d+)?\s*(?:\uCABD|\uBA74|\uAD8C|\uD638|\uD310)/g,
]
const NUMERAL = /\d+(?:[.,]\d+)*/g

/** A fact element is bound by its ledger row, not traced here; it reads as one opaque token. */
const isFact = (node) => node.attrs?.["data-fact"] !== undefined || node.attrs?.["data-translates"] !== undefined || node.tag === "q" || node.tag === "blockquote"

function lines(node, out = [""]) {
	for (const child of node.children ?? []) {
		if (child.tag === "#text") out[out.length - 1] += child.text
		else if (SKIP.has(child.tag)) continue
		else if (isFact(child)) out[out.length - 1] += ` ${FACT} `
		else if (child.tag === "cite" || child.tag === "i" || child.tag === "em") {
			const [open, close] = child.tag === "cite" ? [CITE_OPEN, CITE_CLOSE] : [EM_OPEN, EM_CLOSE]
			out[out.length - 1] += open
			lines(child, out)
			out[out.length - 1] += close
		} else {
			if (BREAK.has(child.tag)) out.push("")
			lines(child, out)
			if (child.tag === "a" && /^https?:\/\//i.test(child.attrs?.href ?? "")) out[out.length - 1] += ` ${LINK} `
			if (BREAK.has(child.tag)) out.push("")
		}
	}
	return out
}

/** Spans [start, end) of the citation fields in `text`; an <i>/<em> run is a title only right before a URL, a link, or a date. */
function fieldSpans(text) {
	const spans = []
	for (const re of FIELDS) for (const match of text.matchAll(re)) spans.push([match.index, match.index + match[0].length])
	for (const match of text.matchAll(new RegExp(`${EM_OPEN}[^${EM_CLOSE}]*${EM_CLOSE}`, "g"))) {
		const after = text.slice(match.index + match[0].length).replace(/^[\s,.:;()\u2013-]*/, "")
		if (after.startsWith(LINK) || /^(?:https?:\/\/|www\.)/i.test(after) || DATE_AHEAD.test(after)) spans.push([match.index, match.index + match[0].length])
	}
	return spans
}

const inside = (spans, start, end) => spans.some(([s, e]) => start >= s && end <= e)

/** Sentences of one line; a period after an abbreviation, an initial, or inside a field never ends one. */
function sentences(line) {
	const spans = fieldSpans(line)
	const out = []
	let start = 0
	for (const match of line.matchAll(/[.!?](?=\s+\S|$)/g)) {
		const end = match.index + 1
		if (NOT_END.test(line.slice(start, end)) || inside(spans, match.index, end)) continue
		out.push(line.slice(start, end))
		start = end
	}
	out.push(line.slice(start))
	return out.map((text) => text.replace(/\s+/g, " ").trim()).filter(Boolean)
}

/** The sentence holds a numeral that is not a citation-field number, so the gates check it. */
export function isClaimSegment(text) {
	const spans = fieldSpans(text)
	for (const match of text.matchAll(NUMERAL)) if (!inside(spans, match.index, match.index + match[0].length)) return true
	return false
}

const plain = (text) => text.replace(/[\u0002-\u0006]/g, " ").replace(/\s+/g, " ").trim()
const lineClaims = (line) => sentences(line).filter(isClaimSegment).map(plain)

/** The checked sentences of an element under Sources ([] when every numeral is a citation field). */
export function sourcesClaims(node) {
	return lines(node).flatMap(lineClaims)
}

/** The checked sentences of loose text (a text node owned by a container element rather than a prose element). */
export function textClaims(text) {
	return lines({ children: [{ tag: "#text", text }] }).flatMap(lineClaims)
}
