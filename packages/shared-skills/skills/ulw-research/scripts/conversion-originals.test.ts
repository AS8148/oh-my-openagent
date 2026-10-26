import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { derive } from "./fact-derive.mjs"
import { fill } from "./fact-fill.mjs"
import { addRow, emptyLedger } from "./fact-ledger.mjs"
import { checkFidelity } from "./gates-fidelity.mjs"
import { valueChecks } from "./fidelity-values.mjs"
import { buildContext } from "./gates-static.mjs"
import { parseHtml } from "./html-lite.mjs"

type Row = Record<string, unknown> & { fact_id: string }
type Ledger = { rows: Row[] }
const FIX = join(import.meta.dir, "tests", "fixtures", "fidelity")
const BASE: Ledger = JSON.parse(readFileSync(join(FIX, "ledger-verify.json"), "utf8"))
const BRIEF = readFileSync(join(FIX, "..", "fidelity-brief-locked.md"), "utf8")
const check = (html: string, ledger: Ledger = BASE, sources: string | null = join(FIX, "sources")) =>
	valueChecks(buildContext(parseHtml(`<h2>Findings</h2>${html}`), { baseDir: FIX }), ledger, null, sources)
const data = (id: string, shown: string) => `<p><data data-fact="${id}">${shown}</data></p>`
const rowOf = (ledger: Ledger, id: string) => ledger.rows.find((r) => r.fact_id === id) as Row

function measured(id: string, value: string, unit: string, extra: Record<string, unknown> = {}) {
	return { fact_id: id, kind: "measured", value, unit, raw: `${value} ${unit}`, quote: `The figure is ${value} ${unit}.`, source_id: "S1", locator: { artifact: "sources/S1/text.txt", char_start: 0, char_end: 5 }, snapshot_sha256: "a".repeat(64), extracted_by: "fact add --find", observed_at: "2026-10-23T08:00:00Z", label: id.toLowerCase(), ...extra }
}

/** A derive-produced row filled by fact fill, so the report is exactly what the tools wrote. */
function derivedReport(rows: Row[], spec: Record<string, unknown>) {
	const ledger = emptyLedger() as Ledger
	for (const row of rows) addRow(ledger, row)
	const result = derive(ledger, spec) as { row?: Row; error?: string }
	if (!result.row) throw new Error(`derive refused: ${result.error}`)
	const filled = fill(`<h2>Findings</h2><p>The total is {{${result.row.fact_id}:${result.row.label}}}.</p>`, ledger)
	if (filled.out === null) throw new Error("fill failed")
	return { ledger, row: result.row, html: filled.out }
}

describe("the converted half of a derived or converted row is display(value, unit)", () => {
	const dated = { valid_at: "2026-10-01" }
	const cases: [string, Row[], Record<string, unknown>][] = [
		["a grouped KRW-e8 sum", [measured("F1", "1617", "KRW-e8"), measured("F2", "1617", "KRW-e8")], { op: "sum", operands: ["F1", "F2"], unit: "KRW-e8" }],
		["a grouped KRW-e3 sum", [measured("F1", "1617", "KRW-e3"), measured("F2", "1617", "KRW-e3")], { op: "sum", operands: ["F1", "F2"], unit: "KRW-e3" }],
		["a grouped KRW-e4 sum", [measured("F1", "1617", "KRW-e4"), measured("F2", "1617", "KRW-e4")], { op: "sum", operands: ["F1", "F2"], unit: "KRW-e4" }],
		["a grouped KRW-e12 sum", [measured("F1", "1617", "KRW-e12"), measured("F2", "1617", "KRW-e12")], { op: "sum", operands: ["F1", "F2"], unit: "KRW-e12" }],
		["a km/h sum", [measured("F1", "30000", "km/h"), measured("F2", "30000", "km/h")], { op: "sum", operands: ["F1", "F2"], unit: "km/h" }],
		["a KRW/person sum", [measured("F1", "30000", "KRW/person"), measured("F2", "30000", "KRW/person")], { op: "sum", operands: ["F1", "F2"], unit: "KRW/person" }],
		["an FX expr in KRW-e8", [measured("F1", "12", "USD", dated), measured("F2", "1420", "KRW-e8/USD", dated)], { op: "expr", formula: "F1 * F2", unit: "KRW-e8" }],
	]
	for (const [name, rows, spec] of cases) {
		test(`#given ${name} exactly as fill wrote it #when verified #then no defect`, () => {
			const { ledger, html } = derivedReport(rows, spec)
			expect(valueChecks(buildContext(parseHtml(html), {}), ledger, null, null)).toEqual([])
		})
	}

	test("#given a grouped KRW-e8 sum whose converted half was edited #when verified #then it still blocks", () => {
		const { ledger, row, html } = derivedReport(cases[0][1], cases[0][2])
		const edited = html.replace(`>${String(row.raw)}<`, ">3,243 KRW-e8<")
		expect(edited).not.toBe(html)
		expect(valueChecks(buildContext(parseHtml(edited), {}), ledger, null, null).map((d: { code: string }) => d.code)).toContain("value_mismatch")
	})
})

describe("conversion originals bind both halves", () => {
	for (const [shown, code] of [["320,000 mm (320 mm)", "unit_mismatch"], ["320,000 mm (999 m)", "value_mismatch"]]) {
		test(`#given an edited original ${shown} #when verified #then ${code} on part original`, () => {
			expect(check(data("F8", shown))).toContainEqual(expect.objectContaining({ code, part: "original" }))
			expect(checkFidelity(data("F8", shown), { ledger: BASE, brief: BRIEF }).defects).toContainEqual(expect.objectContaining({ code, part: "original" }))
		})
	}

	test("#given a ledger render edited to match a tampered report #when verified #then the original stays bound to its operand", () => {
		const ledger = structuredClone(BASE)
		rowOf(ledger, "F8").render = "320,000 mm (999 m)"
		expect(check(data("F8", "320,000 mm (999 m)"), ledger)).toContainEqual(expect.objectContaining({ code: "value_mismatch", part: "original" }))
	})

	test("#given untampered, bracket-free, and edited converted halves #when verified #then only the edits raise", () => {
		expect(check(data("F8", "320,000 mm (320 m)"))).toEqual([])
		expect(check(data("F8", "Converted: 320,000 mm"))).toEqual([])
		expect(check(data("F8", "319,000 mm (320 m)"))).toContainEqual(expect.objectContaining({ code: "value_mismatch" }))
		expect(check(data("F8", "320,000 mm (320 m"))).toContainEqual(expect.objectContaining({ code: "value_mismatch", part: "original" }))
	})

	test("#given a bracket holding no number #when verified #then it is prose, not an original", () => {
		expect(check(data("F8", "320,000 mm (approx.)"))).toEqual([])
		expect(check(data("F8", "320,000 mm (approx.) (320 m)"))).toEqual([])
	})

	test("#given grouped and percent originals #when verified #then the operation display contract holds", () => {
		const ledger = structuredClone(BASE)
		rowOf(ledger, "F1").value = "1237"
		const converted = rowOf(ledger, "F8")
		converted.value = "1237000"
		expect(check(data("F8", "1,237,000 mm (1,237 m)"), ledger)).toEqual([])
		Object.assign(converted, { kind: "derived", value: "0.12", unit: null, derived_from: ["F3"] })
		expect(check(data("F8", "0.12 (12%)"), ledger)).toEqual([])
	})
})
