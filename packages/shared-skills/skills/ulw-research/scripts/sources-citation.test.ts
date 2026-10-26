import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { valueChecks } from "./fidelity-values.mjs"
import { buildContext, checkStatic } from "./gates-static.mjs"
import { parseHtml } from "./html-lite.mjs"
import { isClaimSegment, sourcesClaims } from "./sources-citation.mjs"

const FIX = join(import.meta.dir, "tests", "fixtures")
const EMPTY = { schemaVersion: 1, rows: [], events: [] }
const GATED = new Set(["unsourced_number", "untraceable_number", "verification_claim_unmarked"])

/** The codes the static gate, the number trace, and the claim check raise over one document. */
function gated(html: string) {
	const doc = parseHtml(html)
	const fidelity = valueChecks(buildContext(doc, {}), EMPTY, null, null) as { code: string }[]
	return [...(checkStatic(doc).defects as { code: string }[]), ...fidelity].map((d) => d.code).filter((code) => GATED.has(code))
}
const underSources = (body: string) => gated(`<h2>Official sources</h2>${body}`)

// Decision 25: under Sources a sentence is checked unless every numeral in it is a citation-field number.
// Receipt cases from review rounds 1-3, EN and KO (Korean as \u escapes).
const MUST_FLAG = [
	"<p>[S4] says revenue rose 40% in 2025.</p>",
	"<p>[S4] Revenue rose 40% in 2025, the highest on record.</p>",
	"<li>Revenue rose 40% in 2025 according to https://example.com/report</li>",
	"<p>[S4] Annual report 2024, https://example.com/report<br>The check found 42% of spans out of tolerance.</p>",
	"<p>Revenue was 40% higher in 2025.</p>",
	"<p>Revenue totaled 5 billion dollars in 2025.</p>",
	"<p>Note: the market share is 42% as of 2025.</p>",
	"<p>Exports surged 31% to 12 billion in 2025.</p>",
	"<p>[S4] Revenue hit $5 billion in 2025.</p>",
	"<p>[S4] The agency estimates 3.2 million users.</p>",
	"<p>Revenue was 40 percent higher in 2025.</p>",
	"<p>Market share is 42 percent.</p>",
	"<p>Model B is 3x faster than model A.</p>",
	"<p>The survey covered 1,200 firms in 2025.</p>",
	"<p>The dataset includes 3412 reports.</p>",
	"<p>We reviewed the filings. Market share reached 42% in 2025. Source: https://example.com/a</p>",
	"<p>Note. Revenue grew 40% in 2025. Accessed 2025-10-01.</p>",
	"<p>See the notes below. Unemployment was 4.1% in September. 2025.</p>",
	"<li>[S5] Bloomberg (2025). Revenue grew 40% as AI demand reached record. https://example.com/bloomberg</li>",
	"<p>[S19] Treasury buyback $94B 2026-10-08: https://example.com/2026/10/08/buybacks</p>",
	"<li>Llama 3.1 model card, Meta, https://example.com/llama</li>",
	"<li>Survey 2025, wave 2, https://example.com/survey</li>",
	'<li><a href="https://example.com/notice">Spin-off notice (2025-12-02, \uACF5\uB3D9\uCC3D\uC5C5\uC790 20\uBA85 \uC11C\uBA85)</a></li>',
	"<p>\uC810\uC720\uC728\uC740 42%\uC774\uB2E4.</p>",
	"<p>\uB9E4\uCD9C\uC740 2025\uB144 40% \uB298\uC5B4 5\uC870\uC6D0\uC744 \uAE30\uB85D\uD588\uB2E4.</p>",
	"<p>\uC9C1\uC6D0 \uC218\uB294 1,250\uBA85\uC774\uB2E4.</p>",
	"<p>We ran the check and it reported 42%.</p>",
]

const MUST_PASS = [
	'<li>[S3] Reuters, "China\'s exports rose 7% in September", 2025-10-13, https://example.com/reuters</li>',
	'<li>[S6] \uC5F0\uD569\uB274\uC2A4, "\uC218\uCD9C 12% \uC99D\uAC00\uD588\uB2E4", 2025-10-01, https://example.com/yna</li>',
	"<li>[S7] Nikkei, \u201CSales fell 3.5% in Q2\u201D, https://example.com/nikkei</li>",
	"<li>[S9] \uC5F0\uD569\uB274\uC2A4, \u300C\uC218\uCD9C 12% \uC99D\uAC00\u300D, 2025\uB144 10\uC6D4 1\uC77C</li>",
	"<li>[S8] LoCoMo arXiv 2402.17753; DOI 10.1145/1571941.1572114</li>",
	"<li>Field guide, ISBN 978-0-306-40615-7, 3rd edition, pp. 12-15.</li>",
	"<li><cite>Llama 3.1 model card</cite>, Meta, https://example.com/llama</li>",
	'<li>"Python 3.12 release notes", 2024-10-07, https://example.com/python</li>',
	"<li><em>WCAG 2.2</em>, 2023-10-05, https://example.com/wcag</li>",
	"<li>Smith, J. (2024a). Annual report. https://example.com/annual-2024</li>",
	"<li>Bridge Review, Vol. 2024/1, No. 3, https://example.com/review. Accessed 25 October 2026.</li>",
	"<li>\uAD50\uB7C9 \uC5F0\uAC10 3\uAD8C 2\uD638, 45-52\uCABD, 2024\uB144</li>",
	"<p>[S4] Annual report, 2024. https://example.com/report</p>",
	'<p><a href="https://example.com/2024">Annual report 2024</a></p>',
	"<li>Annual report 2024, https://example.com/report</li>",
	'<li>Annual report 2024, <a href="https://example.com/report">source</a></li>',
	"<h3>2024</h3>",
	"<p>Publication cutoff and access date: October 25, 2026. Every linked source was read directly.</p>",
]

describe("under Sources, a sentence with a numeral that is not a citation field is checked", () => {
	for (const body of MUST_FLAG) test(`#given ${JSON.stringify(body)} #when checked #then untraceable_number`, () => expect(underSources(body)).toContain("untraceable_number"))

	test("#given a citation, then a claim after <br> #when traced #then only the claim sentence's numbers are flagged", () => {
		expect(underSources("<p>[S4] Annual report 2024, https://example.com/report<br>Revenue rose 42% in 2025.</p>").filter((code) => code === "untraceable_number")).toHaveLength(2)
	})

	test("#given a first-person cue with a claim number under Sources #when checked #then the claim check warns too", () => {
		expect(underSources("<p>We confirmed that the rate is 42%.</p>")).toEqual(expect.arrayContaining(["unsourced_number", "untraceable_number", "verification_claim_unmarked"]))
	})
})

describe("an element whose every numeral is a citation field is exempt", () => {
	for (const body of MUST_PASS) test(`#given ${JSON.stringify(body)} #when checked #then nothing`, () => expect(underSources(body)).toEqual([]))

	test("#given a report with every reference shape (APA, pages, volume, access dates, year subheading, dl, Sources table) #when checked #then no gated code", () => {
		expect(gated(readFileSync(join(FIX, "sources-shapes.html"), "utf8"))).toEqual([])
	})
})

// Mutation test: each heuristic the literal rule replaced, re-introduced as a gate on the predicate,
// must miss at least one must-flag case, so restoring any of them in sources-citation.mjs fails above.
const OLD_MEASURE = [/\d\s?(?:%|\u2030|\uD37C\uC13C\uD2B8)/, /[$\u20AC\u00A3\u00A5\u20A9]\s?\d/, /\d\s?(?:thousand|million|billion|trillion|bn)\b|\d(?:k|K|M|B)\b/, /\d\s?(?:\uC6D0|\uB2EC\uB7EC|\uBA85|\uAC74|\uAC1C|\uBC30|[\uCC9C\uB9CC\uC5B5\uC870])/, /\d\s?(?:km|kg|mm|ms|hours?|days?|users?|people|employees|customers?)\b/, /(?<![\d.,])(?!(?:19|20)\d{2}\.)\d+\.\d+(?![\d.])/]
const OLD_VERBS = /\b(?:rose|rises|grew|increased|decreased|declined|dropped|reached|says|said|stated|reported|showed|found|estimated|according\s+to)\b|\uC99D\uAC00\uD588|\uAC10\uC18C\uD588|\uB298\uC5C8|\uC904\uC5C8|\uAE30\uB85D\uD588/
const citationOnly = (text: string) => /https?:\/\/|\b(?:accessed|retrieved)\b/i.test(text)
const root = (body: string) => parseHtml(`<div>${body}</div>`)
/** The mutants' own sentence split of a case (line breaks, then sentence ends); the real predicate decides each piece. */
const pieces = (body: string) =>
	body
		.replace(/<br>/g, "\n")
		.replace(/<[^>]+>/g, " ")
		.split("\n")
		.flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z\uAC00-\uD7A3])/))
		.map((piece) => piece.trim())
		.filter(Boolean)
const MUTANTS: Record<string, (body: string) => boolean> = {
	"a measure-word allow-list": (body) => pieces(body).some((s) => isClaimSegment(s) && OLD_MEASURE.some((re) => re.test(s))),
	"a claim-verb trigger": (body) => pieces(body).some((s) => isClaimSegment(s) && OLD_VERBS.test(s)),
	"the middle-segment title heuristic": (body) => {
		const all = pieces(body)
		return all.some((s, at) => !(at > 0 && at + 1 < all.length && citationOnly(all[at + 1])) && isClaimSegment(s))
	},
}

describe("mutation: no word list, verb list, or title heuristic decides a Sources sentence", () => {
	test("#given the literal rule #when every must-flag case is read #then each yields a checked sentence and no must-pass case does", () => {
		expect(MUST_FLAG.filter((body) => sourcesClaims(root(body)).length === 0)).toEqual([])
		expect(MUST_PASS.filter((body) => sourcesClaims(root(body)).length > 0)).toEqual([])
	})

	for (const [name, mutant] of Object.entries(MUTANTS)) {
		test(`#given ${name} re-introduced #when the must-flag cases run #then at least one is missed`, () => {
			expect(MUST_FLAG.filter((body) => !mutant(body)).length).toBeGreaterThan(0)
		})
	}
})
