import { describe, expect, onTestFinished, test } from "bun:test"
import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { valueChecks } from "./fidelity-values.mjs"
import { buildContext } from "./gates-static.mjs"
import { parseHtml } from "./html-lite.mjs"
import { run } from "./report-tools.mjs"

type Row = Record<string, unknown> & { fact_id: string }
type VerifyResult = { exitCode: number; json: { defects: { code: string; severity: string }[] } }
const FIX = join(import.meta.dir, "tests", "fixtures")
const BASE: { rows: Row[] } = JSON.parse(readFileSync(join(FIX, "fidelity", "ledger-verify.json"), "utf8"))
const F1 = BASE.rows.find((r) => r.fact_id === "F1") as Row
const extra = (fact_id: string, label: string, raw: string, value: string, unit: string, num: string, den = "1"): Row => ({ ...F1, fact_id, label, raw, value, unit, exact: { num, den } })
// Korean units and particles as \u escapes: pp (peosenteu pointeu), eok won, myeong, geon, dalleo, particles ro/euro/ui/ida.
const LEDGER = {
	...BASE,
	rows: [
		...BASE.rows,
		extra("F20", "gap_pp", "3.2%p", "3.2", "%p", "16", "5"),
		extra("F21", "rev_eok", "3,234 KRW-e8", "3234", "KRW-e8", "3234"),
		extra("F22", "staff", "5\uBA85", "5", "person", "5"),
		extra("F23", "price", "$12", "12", "USD", "12"),
		extra("F24", "deck_len", "1.2 km", "1.2", "km", "6", "5"),
	],
}

async function filled(body: string, format = "html") {
	const dir = mkdtempSync(join(tmpdir(), "value-mode-unit-"))
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
	writeFileSync(join(dir, "fact-ledger.json"), JSON.stringify(LEDGER))
	copyFileSync(join(FIX, "fidelity-brief-locked.md"), join(dir, "brief.md"))
	cpSync(join(FIX, "fidelity", "sources"), join(dir, "sources"), { recursive: true })
	const source = join(dir, `report.src.${format}`)
	const report = join(dir, `report.${format}`)
	writeFileSync(source, body)
	const result = await run(["fact", "fill", source, "--out", report, "--session-dir", dir])
	expect(result.exitCode).toBe(0)
	const verify = async () => (await run(["fact", "verify", report, "--session-dir", dir])) as VerifyResult
	const edit = (from: string, to: string) => writeFileSync(report, readFileSync(report, "utf8").replace(from, to))
	return { verify, edit }
}

const codes = (result: VerifyResult) => result.json.defects.map((d) => d.code)
const prose = (pointer: string, tail: string) => `<h2>Findings</h2><p>Up to ${pointer}${tail} [S4].</p>`

describe("value-mode unit binding through fact fill and verify", () => {
	for (const format of ["html", "md"]) {
		test(`#given ${format} value mode followed by meters #when edited to mm #then verify fails unit_mismatch`, async () => {
			const body = format === "html" ? prose("{{F1:span_len:value}}", " meters") : "## Findings\n\nUp to {{F1:span_len:value}} meters [S4]."
			const { verify, edit } = await filled(body, format)
			expect((await verify()).exitCode).toBe(0)
			edit(" meters", " mm")
			const edited = await verify()
			expect(codes(edited)).toContain("unit_mismatch")
			expect(edited.exitCode).toBe(1)
		})
	}

	for (const [pointer, tail] of [
		["{{F1:span_len:value}}", " m in total length"],
		["{{F20:gap_pp:value}}", " \uD37C\uC13C\uD2B8 \uD3EC\uC778\uD2B8\uB85C"],
		["{{F21:rev_eok:value}}", " \uC5B5 \uC6D0\uC73C\uB85C"],
	]) {
		test(`#given ordinary prose ${JSON.stringify(tail)} after ${pointer} #when verified #then it binds the row's own unit, never a squashed join`, async () => {
			const result = await (await filled(prose(pointer, tail))).verify()
			expect(codes(result)).toEqual([])
			expect(result.exitCode).toBe(0)
		})
	}

	for (const [pointer, tail, from, to] of [
		["{{F1:span_len:value}}", "m", "</data>m", "</data>mm"],
		["{{F3:rate_yoy:value}}", "%", "</data>%", "</data>%p"],
		["{{F1:span_len:value}}", " m\uC758", " m\uC758", " mm\uC758"],
		["{{F21:rev_eok:value}}", "\uC5B5 \uC6D0\uC73C\uB85C", "\uC5B5 \uC6D0\uC73C\uB85C", "\uC5B5 \uB2EC\uB7EC\uB85C"],
		["{{F22:staff:value}}", "\uBA85\uC774\uB2E4", "\uBA85\uC774\uB2E4", "\uAC74\uC774\uB2E4"],
		["${{F23:price:value}}", "", "$<data", "\u20AC<data"],
	]) {
		test(`#given the documented form ${pointer}${tail} #when its unit is hand-edited #then unit_mismatch blocks`, async () => {
			const { verify, edit } = await filled(prose(pointer, tail))
			const clean = await verify()
			expect(codes(clean)).toEqual([])
			edit(from, to)
			const edited = await verify()
			expect(codes(edited)).toContain("unit_mismatch")
			expect(edited.exitCode).toBe(1)
		})
	}

	test("#given no following unit #when verified #then unit_unbound is a minor warning", async () => {
		const result = await (await filled(prose("{{F1:span_len:value}}", " long"))).verify()
		expect(result.exitCode).toBe(0)
		expect(result.json.defects).toContainEqual(expect.objectContaining({ code: "unit_unbound", severity: "minor" }))
		expect((result.json as { gatesRun?: string[] }).gatesRun).toContain("unit_unbound")
	})

	test("#given the documented split form :value then :unit #when verified #then the unit element binds", async () => {
		expect(codes(await (await filled(prose("{{F1:span_len:value}} {{F1:span_len:unit}}", ""))).verify())).toEqual([])
	})

	test("#given a converted row in value mode followed by its unit #when verified #then display(value, unit) still verifies", async () => {
		expect(codes(await (await filled(prose("{{F8:span_mm:value}}", " mm"))).verify())).not.toContain("unit_mismatch")
	})

	test("#given the sign already inside a value-mode element (valueParts falling back to the raw text) #when checked #then it is bound", () => {
		const element = (shown: string) => `<h2>Findings</h2><p><data class="fact" value="12" data-fact="F23" data-unit="USD" data-fact-mode="value" data-lineage="MEASURED">${shown}</data> [S4].</p>`
		const found = (shown: string) => (valueChecks(buildContext(parseHtml(element(shown)), {}), LEDGER, null, null) as { code: string }[]).map((d) => d.code)
		expect(found("$12")).not.toContain("unit_unbound")
		expect(found("$12")).not.toContain("unit_mismatch")
	})

	test("#given a dimensionless value #when no unit follows #then no unit warning", async () => {
		expect(codes(await (await filled("<p>{{F2:units_sold:value}} [S4].</p>")).verify())).not.toContain("unit_unbound")
	})
})

describe("value-mode units in tables bind by visual column", () => {
	const table = (head: string, rows: string) => `<h2>Findings</h2><table><thead>${head}</thead><tbody>${rows}</tbody></table>`
	for (const [name, html, code] of [
		["a matching header", table("<tr><th>Span (meters)</th></tr>", "<tr><td>{{F1:span_len:value}}</td></tr>"), null],
		["a wrong header", table("<tr><th>Span (mm)</th></tr>", "<tr><td>{{F1:span_len:value}}</td></tr>"), "unit_mismatch"],
		["a conflicting suffix", table("<tr><th>Span (m)</th></tr>", "<tr><td>{{F1:span_len:value}} mm</td></tr>"), "unit_mismatch"],
		["a header disagreeing with a suffix", table("<tr><th>Span (mm)</th></tr>", "<tr><td>{{F1:span_len:value}} m</td></tr>"), "unit_mismatch"],
		["a unit only in another column", table("<tr><th>Span</th><th>Offset (m)</th></tr>", "<tr><td>{{F1:span_len:value}}</td><td>unknown</td></tr>"), "unit_unbound"],
		["a colspan earlier in the row", table("<tr><th>Bridge</th><th>Deck (km)</th><th>Span (m)</th></tr>", '<tr><td colspan="2">Bridge A</td><td>{{F1:span_len:value}}</td></tr>'), null],
		["a rowspan from above", table("<tr><th>Bridge</th><th>Span (m)</th><th>Deck (km)</th></tr>", '<tr><td rowspan="2">A</td><td>x</td><td>y</td></tr><tr><td>{{F1:span_len:value}}</td><td>{{F24:deck_len:value}}</td></tr>'), "unit_unbound"],
		["a headerless key/value table", "<h2>Findings</h2><table><tr><td>Deck</td><td>{{F24:deck_len}}</td></tr><tr><td>Span</td><td>{{F1:span_len:value}}</td></tr></table>", "unit_unbound"],
	] as const) {
		test(`#given ${name} #when verified #then ${code ?? "it binds cleanly"}`, async () => {
			const result = await (await filled(html)).verify()
			if (code === null) expect(codes(result)).toEqual([])
			else expect(codes(result)).toContain(code)
			expect(result.exitCode).toBe(code === "unit_mismatch" ? 1 : 0)
			if (code !== "unit_mismatch") expect(codes(result)).not.toContain("unit_mismatch")
		})
	}
})
