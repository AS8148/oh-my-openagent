// claim-kinds.mjs - the claim kinds a report sentence can carry, as one table, CLAIM_KINDS.
//
// A claim kind is structural: the writer marks it in the placeholder ({{V:F12:label}}), fill
// emits it as the data-claim-kind attribute on the element it renders, and the fidelity gate
// (fidelity-claims.mjs) checks that every marked element cites a row the kind accepts. An
// unmarked element is a plain fact or quote and is checked only by the value and quote checks.
// The one lexical piece is `unmarked`: a short phrase list that raises a minor warning when a
// sentence reads like the kind but carries no mark; it never raises a major. The table in
// references/fidelity-claim-kinds.md is rendered from CLAIM_KINDS (`node claim-kinds.mjs --render-doc`).
// Pure; node: builtins only. Korean phrases are \u escapes.

import { isCliEntry } from "./entry-guard.mjs"

export const CLAIM_ATTRIBUTE = "data-claim-kind"

const kind = (entry) => Object.freeze({ ...entry, rowKinds: Object.freeze(entry.rowKinds), sourceKinds: entry.sourceKinds && Object.freeze(entry.sourceKinds), unmarked: entry.unmarked && Object.freeze({ ...entry.unmarked, phrases: Object.freeze(entry.unmarked.phrases) }) })

/**
 * kind -> { prefix: placeholder prefix (null = the default form), placeholder: an example,
 *   rowKinds: ledger row kinds it accepts, sourceKinds: snapshot meta.json kinds it requires
 *   (null = any), defect: code when a marked element cites a row it refuses,
 *   unmarked: { code, phrases } for an unmarked sentence that reads like the kind, or null }.
 */
export const CLAIM_KINDS = Object.freeze({
	fact: kind({ prefix: null, placeholder: "{{F12:label}}", rowKinds: ["measured"], sourceKinds: null, defect: "claim_kind_mismatch", unmarked: null }),
	quote: kind({ prefix: null, placeholder: "{{Q7:label}}", rowKinds: ["quote"], sourceKinds: null, defect: "claim_kind_mismatch", unmarked: null }),
	verified: kind({
		prefix: "V",
		placeholder: "{{V:F12:label}}",
		rowKinds: ["measured", "quote"],
		sourceKinds: ["command"],
		defect: "unsupported_verification",
		unmarked: {
			code: "verification_claim_unmarked",
			phrases: ["by running", "we ran", "we executed", "we verified by", "\uC2E4\uD589\uD574 \uD655\uC778", "\uC2E4\uD589\uD558\uC5EC \uAC80\uC99D", "\uC9C1\uC811 \uC2E4\uD589"],
		},
	}),
	derived: kind({ prefix: "D", placeholder: "{{D:F12:label}}", rowKinds: ["derived", "converted"], sourceKinds: null, defect: "claim_kind_mismatch", unmarked: null }),
	assumed: kind({ prefix: "A", placeholder: "{{A:F12:label}}", rowKinds: ["assumed"], sourceKinds: null, defect: "claim_kind_mismatch", unmarked: null }),
})

/** Whether a row (and the meta.json kind of its source snapshot) satisfies a claim kind. */
export function claimSatisfied(name, row, sourceKind) {
	const entry = CLAIM_KINDS[name]
	return Boolean(entry && row && entry.rowKinds.includes(row.kind) && (entry.sourceKinds === null || entry.sourceKinds.includes(sourceKind)))
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const LATIN = /^[\x20-\x7e]+$/
const PHRASES = Object.entries(CLAIM_KINDS)
	.filter(([, entry]) => entry.unmarked)
	.map(([name, entry]) => [name, entry.unmarked.phrases.map((phrase) => (LATIN.test(phrase) ? new RegExp(`\\b${escape(phrase).replace(/ /g, "\\s+")}\\b`, "i") : new RegExp(escape(phrase).replace(/ /g, "\\s*"))))])

/** The kinds whose unmarked phrase list matches the sentence. */
export function unmarkedKinds(text) {
	return PHRASES.filter(([, patterns]) => patterns.some((re) => re.test(text))).map(([name]) => name)
}

export const CLAIM_TABLE_BEGIN = "<!-- claim-kinds:begin (rendered from CLAIM_KINDS; do not edit by hand) -->"
export const CLAIM_TABLE_END = "<!-- claim-kinds:end -->"

const code = (text) => `\`${text}\``

/** The Markdown table of references/fidelity-claim-kinds.md. */
export function renderClaimKindTable() {
	const head = ["| Kind | Placeholder | Attribute fill emits | Accepted row kinds | Required source kind | Defect when unsatisfied | Unmarked warning |", "|---|---|---|---|---|---|---|"]
	const lines = Object.entries(CLAIM_KINDS).map(([name, entry]) => {
		const attribute = entry.prefix === null ? `none (or ${code(`${CLAIM_ATTRIBUTE}="${name}"`)})` : code(`${CLAIM_ATTRIBUTE}="${name}"`)
		const source = entry.sourceKinds === null ? "any" : entry.sourceKinds.map(code).join(", ")
		const warn = entry.unmarked ? `${code(entry.unmarked.code)} on ${entry.unmarked.phrases.map((phrase) => (LATIN.test(phrase) ? `"${phrase}"` : phrase.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`))).join(", ")}` : "none"
		return `| ${code(name)} | ${code(entry.placeholder)} | ${attribute} | ${entry.rowKinds.map(code).join(", ")} | ${source} | ${code(entry.defect)} | ${warn} |`
	})
	return `${[...head, ...lines].join("\n")}\n`
}

if (isCliEntry(import.meta.url)) {
	if (process.argv[2] === "--render-doc" && process.argv.length === 3) process.stdout.write(renderClaimKindTable())
	else {
		process.stderr.write("usage: node claim-kinds.mjs --render-doc\n")
		process.exitCode = 2
	}
}
