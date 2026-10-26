// sources-citation.mjs - the one Sources predicate shared by the static, trace, and claim gates.
//
// Under a Sources heading an element is split at <br> and at sentence ends. A segment is a claim
// when it carries a first-person check or run cue (CLAIM_KINDS) or a finite claim verb ("rose",
// "according to", "reached", ...); every other segment is a citation field (tag, author, title, URL,
// page range, volume, access date) and is exempt. Only claim segments are checked, so a reference
// entry never raises and a claim sentence placed under Sources never hides. Headings are titles.
// Pure; sibling imports only. Korean phrases are \u escapes.

import { unmarkedKinds } from "./claim-kinds.mjs"

const SKIP = new Set(["script", "style", "template"])
const BREAK = new Set(["br", "p", "li", "div", "tr", "dd", "dt"])
// Abbreviations whose period never ends a citation sentence: pp., p., vol., no., ed., eds., et al., J. (initials).
const NOT_END = /(?:\b(?:pp?|vol|vols|no|nos|ed|eds|al|ch|sec|fig|vs|e\.g|i\.e|[A-Z])\.)$/i
// Finite claim verbs only; nouns a title may carry (record, reports, states, higher) never count.
const EN_PREDICATE = /\b(?:rose|rises|risen|fell|falls|fallen|grew|grows|grown|increased|decreased|declined|dropped|doubled|tripled|halved|reached|says|said|stated|reported|showed|found|estimated|according\s+to)\b/i
// jeungga-haet, gamso-haet, sangseung-haet, harak-haet, neul-eot, jul-eot, dal-haet, chaji-haet, seongjang-haet, balk-hyeot, ttareumyeon.
const KO_PREDICATE = /\uC99D\uAC00\uD588|\uAC10\uC18C\uD588|\uC0C1\uC2B9\uD588|\uD558\uB77D\uD588|\uB298\uC5C8|\uC904\uC5C8|\uB2EC\uD588|\uCC28\uC9C0\uD588|\uC131\uC7A5\uD588|\uBC1D\uD614|\uB530\uB974\uBA74/

/** A fact element is bound by its ledger row, not traced here; it reads as one opaque token. */
const isFact = (node) => node.attrs?.["data-fact"] !== undefined || node.attrs?.["data-translates"] !== undefined || node.tag === "q" || node.tag === "blockquote"
const FACT_TOKEN = "\u0000"

function lines(node, out = [""]) {
	for (const child of node.children ?? []) {
		if (child.tag === "#text") out[out.length - 1] += child.text
		else if (SKIP.has(child.tag)) continue
		else if (isFact(child)) out[out.length - 1] += ` ${FACT_TOKEN} `
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

/** A segment reads as a claim, not a citation field. */
export function isClaimSegment(text) {
	return unmarkedKinds(text).length > 0 || EN_PREDICATE.test(text.replace(/https?:\/\/\S+/gi, " ")) || KO_PREDICATE.test(text)
}

/** The claim segments of an element under Sources ([] for a reference entry, a heading, or a citation cell). */
export function sourcesClaims(node) {
	if (/^h[1-6]$/.test(node.tag)) return []
	return lines(node).flatMap(sentences).filter(isClaimSegment)
}

/** The claim segments of loose text (a text node owned by a container element rather than a prose element). */
export function textClaims(text) {
	return lines({ children: [{ tag: "#text", text }] }).flatMap(sentences).filter(isClaimSegment)
}
