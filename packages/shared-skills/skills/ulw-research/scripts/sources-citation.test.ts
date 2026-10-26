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
