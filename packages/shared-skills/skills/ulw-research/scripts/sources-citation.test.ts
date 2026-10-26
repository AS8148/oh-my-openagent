import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { valueChecks } from "./fidelity-values.mjs"
import { buildContext, checkStatic } from "./gates-static.mjs"
import { parseHtml } from "./html-lite.mjs"

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

describe("a claim sentence under Sources is never hidden", () => {
	for (const body of [
		"<p>[S4] says revenue rose 40% in 2025.</p>",
		"<p>[S4] Revenue rose 40% in 2025, the highest on record.</p>",
		"<li>Revenue rose 40% in 2025 according to https://example.com/report</li>",
		"<p>[S4] Annual report 2024, https://example.com/report<br>The check found 42% of spans out of tolerance.</p>",
	]) {
		test(`#given ${JSON.stringify(body)} #when checked #then untraceable_number`, () => {
			expect(underSources(body)).toContain("untraceable_number")
		})
	}

	test("#given a citation, then a claim after <br> #when traced #then only the claim segment's number is flagged", () => {
		const found = underSources("<p>[S4] Annual report 2024, https://example.com/report<br>Revenue rose 42% in 2025.</p>")
		expect(found.filter((code) => code === "untraceable_number")).toHaveLength(2)
	})

	test("#given a first-person check cue under Sources #when checked #then the claim check warns", () => {
		expect(underSources("<p>We ran the check and it reported 42%.</p>")).toContain("verification_claim_unmarked")
		expect(underSources("<p>We confirmed that the rate is 42%.</p>")).toEqual(expect.arrayContaining(["unsourced_number", "untraceable_number", "verification_claim_unmarked"]))
	})
})

describe("a measure number outside a citation field makes the segment a claim, whatever its verb", () => {
	for (const body of [
		"<p>Revenue was 40% higher in 2025.</p>",
		"<p>Revenue totaled 5 billion dollars in 2025.</p>",
		"<p>Note: the market share is 42% as of 2025.</p>",
		"<p>Exports surged 31% to 12 billion in 2025.</p>",
		"<p>[S4] Revenue hit $5 billion in 2025.</p>",
		"<p>[S4] Revenue climbed 40% in 2025.</p>",
		"<p>[S4] Revenue jumped 40% in 2025.</p>",
		"<p>[S4] The agency estimates 3.2 million users.</p>",
		"<p>\uC810\uC720\uC728\uC740 42%\uC774\uB2E4.</p>",
		"<p>\uB9E4\uCD9C\uC740 2025\uB144 40% \uB298\uC5B4 5\uC870\uC6D0\uC744 \uAE30\uB85D\uD588\uB2E4.</p>",
	]) {
		test(`#given ${JSON.stringify(body)} under Sources #when checked #then it raises`, () => {
			expect(underSources(body)).toContain("untraceable_number")
		})
	}
})

describe("quoted and headline titles are citation fields", () => {
	for (const body of [
		'<li>[S3] Reuters, "China\'s exports rose 7% in September", 2025-10-13, https://example.com/reuters</li>',
		"<li>[S6] \uC5F0\uD569\uB274\uC2A4, \"\uC218\uCD9C 12% \uC99D\uAC00\uD588\uB2E4\", 2025-10-01, https://example.com/yna</li>",
		"<li>[S5] Bloomberg (2025). Revenue grew 40% as AI demand reached record. https://example.com/bloomberg</li>",
		"<li>[S7] Nikkei, \u201CSales fell 3.5% in Q2\u201D, https://example.com/nikkei</li>",
		"<li>[S8] LoCoMo arXiv 2402.17753; DOI 10.1145/1571941.1572114</li>",
		"<p>[S19] Treasury buyback $94B 2026-10-08: https://example.com/2026/10/08/buybacks-94-billion</p>",
		"<p>[S67] Factory $5B: https://example.com/news/5-billion-valuation</p>",
		'<li><a href="https://example.com/notice">Spin-off notice (2025-12-02, \uACF5\uB3D9\uCC3D\uC5C5\uC790 20\uBA85 \uC11C\uBA85)</a><br><span>https://example.com/notice</span></li>',
	]) {
		test(`#given the reference ${JSON.stringify(body)} #when checked #then nothing`, () => expect(underSources(body)).toEqual([]))
	}
})

describe("ordinary reference entries never raise", () => {
	test("#given a report with every reference shape (APA, pages, volume, access dates, year subheading, dl, Sources table) #when checked #then no gated code", () => {
		expect(gated(readFileSync(join(FIX, "sources-shapes.html"), "utf8"))).toEqual([])
	})

	for (const body of [
		"<p>[S4] Annual report, 2024. https://example.com/report</p>",
		'<p><a href="https://example.com/2024">Annual report 2024</a></p>',
		"<li>Annual report 2024, https://example.com/report</li>",
		'<li>Annual report 2024, <a href="https://example.com/report">source</a></li>',
		"<h3>2024</h3>",
	]) {
		test(`#given the entry ${JSON.stringify(body)} #when checked #then nothing`, () => expect(underSources(body)).toEqual([]))
	}
})
