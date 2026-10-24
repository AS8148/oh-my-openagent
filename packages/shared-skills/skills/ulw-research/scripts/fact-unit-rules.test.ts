import { describe, expect, test } from "bun:test"

import { derive, display, recompute } from "./fact-derive.mjs"
import { addRow, emptyLedger, OPERATIONS } from "./fact-ledger.mjs"
import { canonicalUnit, expectedUnit, isAffine, OPERATION_RULES } from "./unit-rules.mjs"

// Property checks of references/unit-rules.md: every case table below is keyed by the registry's own operation list,
// so a new operation without valid, relabel, and malformed cases fails here.

type Row = Record<string, unknown>
type Ledger = { schemaVersion: number; rows: Row[]; events: unknown[] }
type Spec = Record<string, unknown>

const HASH = "a".repeat(64)

function measured(factId: string, value: string, unit: string | null, extra: Row = {}): Row {
	return {
		fact_id: factId,
		kind: "measured",
		value,
		unit,
		raw: `${value} ${unit ?? ""}`.trim(),
		quote: `The figure is ${value}.`,
		source_id: "S1",
		locator: { artifact: "sources/S1/text.txt", char_start: 0, char_end: 20 },
		snapshot_sha256: HASH,
		extracted_by: "fact add --find",
		observed_at: "2026-10-23T08:00:00Z",
		label: factId.toLowerCase(),
		...extra,
	}
}

function ledger(): Ledger {
	const built = emptyLedger() as Ledger
	const rows = [
		measured("F1", "1", "m"),
		measured("F2", "3", "m"),
		measured("F3", "20", "%"),
		measured("F4", "15", "%"),
		measured("F5", "5", "%p"),
		measured("F6", "100", "case", { valid_at: "2025", entity: "acme" }),
		measured("F7", "112", "case", { valid_at: "2026", entity: "acme" }),
		measured("F8", "40", "person"),
		measured("F9", "200", "person"),
		measured("F10", "100", "USD"),
		measured("F11", "20", "USD/person"),
		measured("F12", "0", "m"),
		measured("F13", "25", "C", { valid_at: "2025", entity: "x" }),
		measured("F14", "30", "C", { valid_at: "2026", entity: "x" }),
		measured("F15", "0", "person"),
		measured("F16", "2.5", "kilometre"),
	]
	for (const row of rows) addRow(built, row)
	return built
}

const PCT_SUM = { op: "sum", operands: ["F3", "F4"], unit: "%", disjoint: true, reference: "all respondents", rationale: "disjoint answer shares" }

const VALID: Record<string, Array<{ spec: Spec; unit: string | null }>> = {
	sum: [
		{ spec: { op: "sum", operands: ["F1", "F2"], unit: "m" }, unit: "m" },
		{ spec: { op: "sum", operands: ["F1", "F2"], unit: "metre" }, unit: "m" },
		{ spec: PCT_SUM, unit: "%" },
	],
	diff: [
		{ spec: { op: "diff", operands: ["F2", "F1"], unit: "m" }, unit: "m" },
		{ spec: { op: "diff", operands: ["F3", "F4"], unit: "pp" }, unit: "%p" },
		{ spec: { op: "diff", operands: ["F3", "F5"], unit: "%" }, unit: "%" },
		{ spec: { op: "diff", operands: ["F14", "F13"], unit: "C" }, unit: "C" },
	],
	growth: [{ spec: { op: "growth", from: "F6", to: "F7", unit: "%" }, unit: "%" }],
	share: [
		{ spec: { op: "share", part: "F8", whole: "F9", unit: "%" }, unit: "%" },
		{ spec: { op: "share", part: "F9", whole: "F9", unit: "%" }, unit: "%" },
	],
	ratio: [
		{ spec: { op: "ratio", num: "F10", den: "F11", unit: "person" }, unit: "person" },
		{ spec: { op: "ratio", num: "F1", den: "F2", unit: null }, unit: null },
		{ spec: { op: "ratio", num: "F10", den: "F9", unit: "USD/person" }, unit: "USD/person" },
	],
	convert: [
		{ spec: { op: "convert", operands: ["F12"], to: "km" }, unit: "km" },
		{ spec: { op: "convert", operands: ["F16"], to: "m" }, unit: "m" },
		{ spec: { op: "convert", operands: ["F2"], to: "kilometre" }, unit: "km" },
	],
	expr: [
		{ spec: { op: "expr", formula: "F3 - F4", unit: "%p" }, unit: "%p" },
		{ spec: { op: "expr", formula: "F1 * F1 / F2", unit: "m" }, unit: "m" },
		{ spec: { op: "expr", formula: "F10 / F11", unit: "person" }, unit: "person" },
		{ spec: { op: "expr", formula: "pct(F8 / F9)", unit: "%" }, unit: "%" },
		{ spec: { op: "expr", formula: "F3 * F9", unit: "person" }, unit: "person" },
	],
}

const RELABELS = [null, "%", "%p", "pp", "bp", "m", "metre", "km", "kilometre", "cm", "C", "case", "person", "USD", "USD/person", "person/USD", "KRW-e8"]

type Mutation = { name: string; base: Spec; mutate: (row: Row) => Row }
const generic = (base: Spec, arity: string[]): Mutation[] => [
	{ name: "operands null", base, mutate: (row) => ({ ...row, operands: null }) },
	{ name: "operands empty", base, mutate: (row) => ({ ...row, operands: [] }) },
	{ name: "wrong arity", base, mutate: (row) => ({ ...row, operands: arity }) },
	{ name: "missing operand id", base, mutate: (row) => ({ ...row, operands: (row.operands as string[]).map((id, index) => (index === 0 ? "F999" : id)) }) },
	{ name: "invalid rational", base, mutate: (row) => ({ ...row, exact: { num: "x", den: "1" } }) },
	{ name: "no operation", base, mutate: (row) => ({ ...row, operation: "mean" }) },
]

const MALFORMED: Record<string, Mutation[]> = {
	sum: [
		...generic(VALID.sum[0].spec, ["F1"]),
		{ name: "% without disjoint", base: PCT_SUM, mutate: (row) => ({ ...row, context: { disjoint: false, reference: "all respondents" } }) },
		{ name: "% without reference", base: PCT_SUM, mutate: (row) => ({ ...row, context: { disjoint: true, reference: null } }) },
		{ name: "% without rationale", base: PCT_SUM, mutate: (row) => ({ ...row, rationale: null }) },
		{ name: "unequal units", base: VALID.sum[0].spec, mutate: (row) => ({ ...row, operands: ["F1", "F8"] }) },
	],
	diff: [...generic(VALID.diff[0].spec, ["F2", "F1", "F1"]), { name: "%p - % pair", base: VALID.diff[2].spec, mutate: (row) => ({ ...row, operands: ["F5", "F3"] }) }],
	growth: [
		...generic(VALID.growth[0].spec, ["F6"]),
		{ name: "affine units", base: VALID.growth[0].spec, mutate: (row) => ({ ...row, operands: ["F13", "F14"] }) },
		{ name: "one period", base: VALID.growth[0].spec, mutate: (row) => ({ ...row, operands: ["F6", "F6"] }) },
	],
	share: [...generic(VALID.share[0].spec, ["F8"]), { name: "part above whole", base: VALID.share[0].spec, mutate: (row) => ({ ...row, operands: ["F9", "F8"] }) }],
	ratio: [...generic(VALID.ratio[0].spec, ["F10"]), { name: "divides by zero", base: VALID.ratio[0].spec, mutate: (row) => ({ ...row, operands: ["F10", "F15"] }) }],
	convert: [
		...generic(VALID.convert[0].spec, ["F12", "F12"]),
		{ name: "no context", base: VALID.convert[0].spec, mutate: (row) => ({ ...row, context: null }) },
		{ name: "empty target", base: VALID.convert[0].spec, mutate: (row) => ({ ...row, context: { target: "" } }) },
		{ name: "no factor to target", base: VALID.convert[0].spec, mutate: (row) => ({ ...row, context: { target: "USD" } }) },
	],
	expr: [
		...generic(VALID.expr[0].spec, ["F3", "F4", "F5"]),
		{ name: "formula id mismatch", base: VALID.expr[0].spec, mutate: (row) => ({ ...row, formula: "F3 - F99" }) },
		{ name: "parse error", base: VALID.expr[0].spec, mutate: (row) => ({ ...row, formula: "F3 -" }) },
		{ name: "divides by zero", base: VALID.expr[0].spec, mutate: (row) => ({ ...row, formula: "F3 / (F4 - F4)" }) },
		{ name: "uninferable unit", base: VALID.expr[0].spec, mutate: (row) => ({ ...row, formula: "F3 + F4" }) },
	],
}

function rowOf(result: { row?: Row; error?: string; detail?: string }): Row {
	if (!result.row) throw new Error(`expected a row, got ${result.error}: ${result.detail}`)
	return result.row
}

function relabel(row: Row, unit: string | null): Row {
	const shown = display(row.value, unit)
	const render = row.operation === "convert" ? `${shown} ${String(row.render).slice(String(row.render).indexOf("("))}` : shown
	return { ...row, unit, raw: render, render }
}

const OPS = Object.keys(OPERATION_RULES)

test("the case tables cover exactly the registry's operations, which are the ledger schema's operations", () => {
	expect([...OPS].sort()).toEqual([...OPERATIONS].sort())
	for (const table of [VALID, MALFORMED]) expect(Object.keys(table).sort()).toEqual([...OPS].sort())
})

describe.each(OPS)("%s", (op) => {
	test("valid typed operands derive, and the stored row recomputes ok", () => {
		for (const { spec, unit } of VALID[op]) {
			const book = ledger()
			const row = rowOf(derive(book, spec))
			expect(row.unit).toBe(unit)
			expect(recompute(book, row)).toMatchObject({ ok: true })
		}
	})

	test("every other unit, alias, or null is a relabel: recompute names the expected unit and derive refuses it", () => {
		for (const { spec, unit } of VALID[op]) {
			const book = ledger()
			const row = rowOf(derive(book, spec))
			for (const other of RELABELS.filter((candidate) => candidate !== unit)) {
				const result = recompute(book, relabel(row, other))
				expect({ other, ok: result.ok }).toEqual({ other, ok: false })
				expect(result.detail).toContain(`expected unit ${JSON.stringify(unit)}`)
				const declared = derive(ledger(), { ...spec, unit: other })
				if (other !== "bp" && canonicalUnit(other) === unit) expect(declared.row?.unit).toBe(unit)
				else expect({ other, error: declared.error }).toEqual({ other, error: "incompatible_operands" })
			}
		}
	})

	test("each malformed shape is ok:false and never throws", () => {
		for (const { name, base, mutate } of MALFORMED[op]) {
			const book = ledger()
			const row = rowOf(derive(book, base))
			let result: { ok: boolean; detail?: string } = { ok: true }
			expect(() => {
				result = recompute(book, mutate(row))
			}).not.toThrow()
			expect({ name, ok: result.ok, hasDetail: typeof result.detail === "string" }).toEqual({ name, ok: false, hasDetail: true })
		}
	})
})

describe("units", () => {
	test("aliases canonicalize at input and composites cancel", () => {
		expect(canonicalUnit("pp")).toBe("%p")
		expect(canonicalUnit("bp")).toBe("%p")
		expect(canonicalUnit("kilometre")).toBe("km")
		expect(canonicalUnit("USD/(USD/person)")).toBe("person")
		expect(canonicalUnit("USD / kg")).toBe("USD/kg")
		expect(canonicalUnit("m/m")).toBeNull()
		expect(canonicalUnit(null)).toBeNull()
		expect(isAffine("C")).toBe(true)
		expect(isAffine("F")).toBe(true)
		expect(isAffine("m")).toBe(false)
	})

	test("expectedUnit is the registry's answer for stored operand rows", () => {
		const book = ledger()
		const rows = (ids: string[]) => ids.map((id) => book.rows.find((row) => row.fact_id === id) as Row)
		expect(expectedUnit("diff", rows(["F3", "F4"]), {})).toBe("%p")
		expect(expectedUnit("ratio", rows(["F10", "F11"]), {})).toBe("person")
		expect(expectedUnit("convert", rows(["F12"]), { context: { target: "km" } })).toBe("km")
	})

	test("nested derived operands are verified recursively; a cycle is refused", () => {
		const book = ledger()
		const inner = rowOf(derive(book, { op: "sum", operands: ["F1", "F2"], unit: "m" }))
		const outer = rowOf(derive(book, { op: "convert", operands: [inner.fact_id as string], to: "km" }))
		expect(recompute(book, outer).ok).toBe(true)
		inner.exact = { num: "5", den: "1" }
		const tampered = recompute(book, outer)
		expect(tampered.ok).toBe(false)
		expect(tampered.detail).toContain(String(inner.fact_id))
		const a = { ...inner, fact_id: "F90", operands: ["F91", "F1"], exact: { num: "4", den: "1" } }
		const b = { ...inner, fact_id: "F91", operands: ["F90", "F1"], exact: { num: "4", den: "1" } }
		book.rows.push(a, b)
		let cycle: { ok: boolean; detail?: string } = { ok: true }
		expect(() => {
			cycle = recompute(book, a)
		}).not.toThrow()
		expect(cycle.ok).toBe(false)
		expect(cycle.detail).toContain("cycle")
	})
})
