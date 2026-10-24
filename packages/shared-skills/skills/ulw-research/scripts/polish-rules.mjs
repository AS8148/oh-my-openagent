// polish-rules.mjs - the one rule set behind polish-apply (per edit) and polish-diff (whole document).
//
// polishDefects(beforeHtml, afterHtml, ledger, {ordered}) compares the visible projections
// (html-visible.visibleMarkup, then polish-project.project) and returns {code, message} per failure.
// Visibility decides presence only; what is hidden is itself protected:
//   polish_diff_fail: fact spans (id + rendered markup), numerals outside fact spans (with units),
//     tickers (TICKER: 1-5 capitals with an optional ".XX" class, or a 6-digit KRX code), or a
//     table's row count changed; the raw markup of a hidden region (hiddenRegions) differs by any
//     byte; a data-fact or data-claim element changed visibility class (visible <-> hidden); or the
//     opening tags (name plus every attribute but MARKUP_FREE_ATTRIBUTES) changed, which also makes
//     a data-claim id change a blocking fact-binding change and closes inline-style hiding;
//   polish_hedging_decreased: a hedge or qualifier the before text holds and must keep is gone;
//   polish_text_churn: more than POLISH_CHURN_LIMIT of the normalized visible prose changed;
//   polish_link_changed: href values changed or an internal #target stopped resolving;
//   polish_name_changed: a proper noun (POLISH_NAME) of a ledger quote, present before, is gone.
// ordered (polish-apply) also refuses a reordering of fact spans, numerals, tickers and links;
// without it they compare as multisets. Severity lives only in contracts.DEFECT_CODES.
// No IO, no model. Plain Node ESM.

import { HIDDEN_ELEMENT_TAGS, hiddenRegions, markedVisibility, tagAttributes, visibleMarkup } from "./html-visible.mjs"
import { missingTerms, numeralKeys, project, requiredTerms } from "./polish-project.mjs"
import { splitSentences } from "./sentence-split.mjs"
import { normalizeText } from "./text-normalize.mjs"

/** The codes polishDefects can emit, in report order. */
export const POLISH_CODES = Object.freeze(["polish_diff_fail", "polish_hedging_decreased", "polish_text_churn", "polish_link_changed", "polish_name_changed"])
export const TICKER = /(?<![\p{L}\p{N}])(?:[A-Z]{1,5}(?:\.[A-Z]{1,2})?|\d{6})(?![\p{L}\p{N}])/gu
/** The capitalized-token heuristic for proper nouns in ledger quotes. */
export const POLISH_NAME = /\p{Lu}[\p{L}\p{N}&'-]+/gu
/** The elements whose content polish ignores: the visibility projection's own list. */
export const POLISH_BODY_IGNORED_TAGS = HIDDEN_ELEMENT_TAGS
/** Above this share of changed normalized prose a polish composed instead of proofreading. */
export const POLISH_CHURN_LIMIT = 0.5
/** Attributes the markup rule leaves to polish_link_changed (href values, internal #targets). */
export const MARKUP_FREE_ATTRIBUTES = Object.freeze(["href", "id"])
/** Above this many cells a gap counts as fully rewritten instead of running the quadratic distance. */
const DISTANCE_CELLS = 25_000_000

const sorted = (list) => [...list].sort()
const same = (a, b) => a.length === b.length && a.every((item, k) => item === b[k])

/** null when unchanged; a reorder counts only when ordered. */
function listChange(label, before, after, ordered) {
	if (same(before, after)) return null
	const remaining = sorted(before)
	const added = []
	for (const item of after) {
		const at = remaining.indexOf(item)
		if (at === -1) added.push(item)
		else remaining.splice(at, 1)
	}
	if (remaining.length > 0 || added.length > 0) return `${label} changed: removed [${remaining.join(", ")}], added [${added.join(", ")}]`
	return ordered ? `${label} reordered: [${before.join(", ")}] became [${after.join(", ")}]` : null
}

/** null when the hidden regions' raw markup is byte-identical (as a sequence when ordered). */
function hiddenChange(beforeHtml, afterHtml, ordered) {
	const [a, b] = [beforeHtml, afterHtml].map((html) => hiddenRegions(html).map((region) => region.markup)).map((list) => (ordered ? list : sorted(list)))
	if (same(a, b)) return null
	const at = Math.max(0, a.findIndex((markup, k) => markup !== b[k]))
	const clip = (markup) => JSON.stringify(markup === undefined ? "(none)" : markup.slice(0, 80))
	return `hidden markup changed: ${a.length} hidden regions before, ${b.length} after; region ${at + 1} was ${clip(a[at])}, now ${clip(b[at])}`
}

const tagKeys = (html) =>
	tagAttributes(html).map(({ name, attrs }) => [name, ...Object.entries(attrs).filter(([key]) => !MARKUP_FREE_ATTRIBUTES.includes(key)).map(([key, value]) => `${key}=${value}`)].join(" "))

const tableRows = (html) => html.split(/<table\b/i).slice(1).map((part) => (part.split(/<\/table\s*>/i)[0].match(/<tr\b/gi) ?? []).length)

function levenshtein(a, b) {
	if (a === b) return 0
	if (a.length * b.length > DISTANCE_CELLS) return Math.max(a.length, b.length)
	let previous = Array.from({ length: b.length + 1 }, (_, k) => k)
	for (let i = 1; i <= a.length; i++) {
		const current = [i]
		for (let j = 1; j <= b.length; j++) {
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
		}
		previous = current
	}
	return previous[b.length]
}

/** Changed share of normalized prose: edit distance over unmatched sentence runs / longer length. */
export function churnRatio(beforeText, afterText) {
	const [a, b] = [normalizeText(beforeText), normalizeText(afterText)]
	const longest = Math.max(a.length, b.length)
	if (longest === 0) return 0
	const [sa, sb] = [splitSentences(a).map((s) => s.text), splitSentences(b).map((s) => s.text)]
	const lcs = Array.from({ length: sa.length + 1 }, () => new Array(sb.length + 1).fill(0))
	for (let i = sa.length - 1; i >= 0; i--) {
		for (let j = sb.length - 1; j >= 0; j--) lcs[i][j] = sa[i] === sb[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
	}
	let distance = 0
	let gap = [[], []]
	const flush = () => {
		distance += levenshtein(gap[0].join(" "), gap[1].join(" "))
		gap = [[], []]
	}
	let [i, j] = [0, 0]
	while (i < sa.length || j < sb.length) {
		if (i < sa.length && j < sb.length && sa[i] === sb[j]) {
			flush()
			i++
			j++
		} else if (j >= sb.length || (i < sa.length && lcs[i + 1][j] >= lcs[i][j + 1])) gap[0].push(sa[i++])
		else gap[1].push(sb[j++])
	}
	flush()
	return distance / longest
}

function linkChange(from, to, before, after, ordered) {
	const change = listChange("href and data-claim values", from.links, to.links, ordered)
	if (change) return change
	const ids = (html) => new Set(tagAttributes(html).flatMap(({ attrs }) => (Object.hasOwn(attrs, "id") ? [attrs.id] : [])))
	const [idsBefore, idsAfter] = [ids(before), ids(after)]
	const targets = to.links.filter((link) => link.startsWith("href=#")).map((link) => link.slice(5))
	const broken = targets.filter((href) => idsBefore.has(href.slice(1)) && !idsAfter.has(href.slice(1)))
	return broken.length > 0 ? `internal link targets stopped resolving: [${[...new Set(broken)].join(", ")}]` : null
}

/** Capitalized tokens of the ledger quotes, minus each sentence's first word. */
function ledgerNames(rows) {
	const names = new Set()
	for (const row of rows) {
		for (const { text } of splitSentences(row.quote ?? "")) {
			const first = text.match(/^\P{L}*\p{L}+/u)?.[0].length ?? 0
			for (const match of text.matchAll(POLISH_NAME)) if (match.index >= first) names.add(match[0])
		}
	}
	return names
}

const hasWord = (text, word) => new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u").test(text)

/**
 * @param {string} beforeHtml
 * @param {string} afterHtml
 * @param {{ rows: object[] }} ledger
 * @param {{ ordered?: boolean }} [options]
 * @returns {{ code: string, message: string }[]} in POLISH_CODES order
 */
export function polishDefects(beforeHtml, afterHtml, ledger, { ordered = false } = {}) {
	const [before, after] = [visibleMarkup(beforeHtml), visibleMarkup(afterHtml)]
	const [from, to] = [project(before), project(after)]
	const rows = ledger?.rows ?? []
	const defects = []
	const note = (code, message) => message && defects.push({ code, message })
	const factKey = (fact) => `${fact.id} ${fact.html}`
	const tickers = (text) => text.match(TICKER) ?? []
	note("polish_diff_fail", listChange("fact spans", from.facts.map(factKey), to.facts.map(factKey), ordered))
	note("polish_diff_fail", listChange("numerals outside fact spans", numeralKeys(from.masked), numeralKeys(to.masked), ordered))
	note("polish_diff_fail", listChange("tickers", tickers(from.masked), tickers(to.masked), ordered))
	note("polish_diff_fail", hiddenChange(beforeHtml, afterHtml, ordered))
	const marked = (html) => markedVisibility(html, ["data-fact", "data-claim"])
	note("polish_diff_fail", listChange("visibility of fact and claim spans", marked(beforeHtml), marked(afterHtml), ordered))
	note("polish_diff_fail", listChange("markup tags", tagKeys(beforeHtml), tagKeys(afterHtml), ordered))
	const [rowsBefore, rowsAfter] = [tableRows(before), tableRows(after)]
	if (!same(rowsBefore, rowsAfter)) note("polish_diff_fail", `table row counts changed: [${rowsBefore}] became [${rowsAfter}]`)
	const missing = missingTerms(requiredTerms(from, new Map(rows.map((row) => [row.fact_id, row]))), to.visible)
	if (missing.length > 0) note("polish_hedging_decreased", `hedges or qualifiers removed: ${missing.map((term) => `"${term}"`).join(", ")}`)
	const ratio = churnRatio(from.visible, to.visible)
	if (ratio > POLISH_CHURN_LIMIT) note("polish_text_churn", `${(ratio * 100).toFixed(1)} percent of the normalized prose changed`)
	note("polish_link_changed", linkChange(from, to, before, after, ordered))
	const lost = [...ledgerNames(rows)].filter((name) => hasWord(from.visible, name) && !hasWord(to.visible, name))
	if (lost.length > 0) note("polish_name_changed", `ledger-quote names missing after polish: ${lost.join(", ")}`)
	return defects.sort((a, b) => POLISH_CODES.indexOf(a.code) - POLISH_CODES.indexOf(b.code))
}
