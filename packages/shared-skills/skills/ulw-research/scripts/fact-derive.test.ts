import { describe, expect, onTestFinished, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { derive, recompute } from "./fact-derive.mjs"
import { addRow, emptyLedger, readLedger, writeLedger } from "./fact-ledger.mjs"

const HASH = "a".repeat(64)
const EOK_WON = "\uC5B5\uC6D0"

type Row = Record<string, unknown>
type Ledger = { schemaVersion: number; rows: Row[]; events: unknown[] }

function measured(factId: string, value: string, unit: string, extra: Row = {}): Row {
	return {
		fact_id: factId,
		kind: "measured",
		value,
		unit,
		raw: `${value} ${unit}`,
		quote: `The figure is ${value} ${unit}.`,
		source_id: "S1",
		locator: { artifact: "sources/S1/text.txt", char_start: 0, char_end: 20 },
		snapshot_sha256: HASH,
		extracted_by: "fact add --find",
		observed_at: "2026-10-23T08:00:00Z",
		label: factId.toLowerCase(),
		...extra,
	}
}

function ledgerOf(rows: Row[]): Ledger {
	const ledger = emptyLedger() as Ledger
	for (const row of rows) addRow(ledger, row)
	return ledger
}

function fixture(): Ledger {
	return ledgerOf([
		measured("F5", "100", EOK_WON, { population: "all" }),
		measured("F6", "200", EOK_WON, { population: "all" }),
		measured("F7", "200", EOK_WON, { population: "subset" }),
		measured("F8", "15", "%"),
		measured("F9", "20", "%"),
		measured("F12", "320", "m"),
		measured("F19", "100", "case", { valid_at: "2025-Q3", entity: "acme" }),
		measured("F20", "112", "case", { valid_at: "2026-Q3", entity: "acme" }),
		measured("F30", "3.2", "m"),
	])
}

function rowOf(result: { row?: Row; error?: string; detail?: string }): Row {
	if (!result.row) throw new Error(`expected a row, got ${result.error}: ${result.detail}`)
	return result.row
}

describe("derive: checked operations", () => {
	test("sum of compatible rows stores the exact sum and appends a derived row", () => {
		const ledger = fixture()
		const row = rowOf(derive(ledger, { op: "sum", operands: ["F5", "F6"], unit: EOK_WON }))
		expect(row).toMatchObject({ fact_id: "F31", kind: "derived", operation: "sum", value: "300", unit: EOK_WON, exact: { num: "300", den: "1" } })
		expect(row.operands).toEqual(["F5", "F6"])
		expect(row.derived_from).toEqual(["F5", "F6"])
		expect(ledger.rows.at(-1)).toBe(row)
	})

	test("sum across declared populations is incompatible and writes nothing", () => {
		const ledger = fixture()
		const result = derive(ledger, { op: "sum", operands: ["F5", "F7"], unit: EOK_WON })
		expect(result.error).toBe("incompatible_operands")
		expect(result.detail).toContain("population")
		expect(ledger.rows).toHaveLength(9)
	})

	test("percent operands: plain sum refused, pp diff and disjoint sum allowed", () => {
		const ledger = fixture()
		expect(derive(ledger, { op: "sum", operands: ["F8", "F9"], unit: "%" }).error).toBe("incompatible_operands")
		expect(derive(ledger, { op: "diff", operands: ["F9", "F8"], unit: "%" }).error).toBe("incompatible_operands")
		expect(rowOf(derive(ledger, { op: "diff", operands: ["F9", "F8"], unit: "pp" }))).toMatchObject({ value: "5", unit: "pp" })
		expect(derive(ledger, { op: "sum", operands: ["F8", "F9"], unit: "%", disjoint: true }).error).toBe("incompatible_operands")
		const disjoint = rowOf(derive(ledger, { op: "sum", operands: ["F8", "F9"], unit: "%", disjoint: true, rationale: "x" }))
		expect(disjoint).toMatchObject({ value: "35", unit: "%", rationale: "x" })
	})

	test("growth needs two periods of the same entity", () => {
		const ledger = fixture()
		const row = rowOf(derive(ledger, { op: "growth", from: "F19", to: "F20", unit: "%" }))
		expect(row).toMatchObject({ value: "12", unit: "%", exact: { num: "12", den: "1" }, operands: ["F19", "F20"] })
		const same = derive(ledger, { op: "growth", from: "F19", to: "F19", unit: "%" })
		expect(same.error).toBe("incompatible_operands")
		expect(same.detail).toContain("valid_at")
	})

	test("an unknown or missing operand is refused", () => {
		const ledger = fixture()
		expect(derive(ledger, { op: "sum", operands: ["F5", "F99"], unit: EOK_WON }).error).toBeDefined()
		expect(ledger.rows).toHaveLength(9)
	})
})

describe("derive: rendered precision", () => {
	const precision = () =>
		ledgerOf([measured("F1", "1000", "m"), measured("F2", "3", "m"), measured("F3", "9", "m"), measured("F4", "1.5", "m"), measured("F5", "20.25", "%"), measured("F6", "15.5", "%"), measured("F7", "19.0", "m")])

	test("a difference keeps the fewest decimal places: 1000 m - 3 m is 997 m", () => {
		const row = rowOf(derive(precision(), { op: "diff", operands: ["F1", "F2"], unit: "m" }))
		expect(row).toMatchObject({ value: "997", render: "997 m", exact: { num: "997", den: "1" } })
	})

	test("a difference keeps the fewest decimal places: 9 m - 1.5 m is 8 m, 19.0 m - 1.5 m is 17.5 m", () => {
		const ledger = precision()
		expect(rowOf(derive(ledger, { op: "diff", operands: ["F3", "F4"], unit: "m" }))).toMatchObject({ value: "8", render: "8 m", exact: { num: "15", den: "2" } })
		expect(rowOf(derive(ledger, { op: "diff", operands: ["F7", "F4"], unit: "m" }))).toMatchObject({ value: "17.5", render: "17.5 m", exact: { num: "35", den: "2" } })
	})

	test("pp with mixed decimal places rounds to the fewest: 20.25 % - 15.5 % is 4.8 pp", () => {
		const ledger = precision()
		const row = rowOf(derive(ledger, { op: "diff", operands: ["F5", "F6"], unit: "pp" }))
		expect(row).toMatchObject({ value: "4.8", render: "4.8 pp", exact: { num: "19", den: "4" } })
		expect(recompute(ledger, row).ok).toBe(true)
	})
})

describe("derive: convert", () => {
	test("320 m to mm keeps the original beside the converted value", () => {
		const ledger = fixture()
		const row = rowOf(derive(ledger, { op: "convert", operands: ["F12"], to: "mm" }))
		expect(row).toMatchObject({ kind: "converted", operation: "convert", value: "320000", unit: "mm", factor: "1000", render: "320,000 mm (320 m)" })
		expect(row.exact).toEqual({ num: "320000", den: "1" })
		expect(row.derived_from).toEqual(["F12"])
	})

	test("3.2 m to cm renders 320 cm at the original precision", () => {
		const ledger = fixture()
		const row = rowOf(derive(ledger, { op: "convert", operands: ["F30"], to: "cm" }))
		expect(row.value).toBe("320")
		expect(String(row.render).startsWith("320 cm")).toBe(true)
		expect(String(row.render)).not.toContain("320.0")
	})

	test("currency conversion is refused with a hint to expr", () => {
		const ledger = fixture()
		const result = derive(ledger, { op: "convert", operands: ["F5"], to: "USD" })
		expect(result.error).toBe("incompatible_operands")
		expect(result.hint).toContain("expr")
		expect(ledger.rows).toHaveLength(9)
	})
})

describe("derive: expr and exact chaining", () => {
	test("expr is unchecked and needs a rationale", () => {
		const ledger = fixture()
		expect(derive(ledger, { op: "expr", formula: "F12 / F30" }).error).toBeDefined()
		const result = derive(ledger, { op: "expr", formula: "F12 / F30", rationale: "span over sample length" })
		expect(result.compatibility).toBe("unchecked")
		expect(rowOf(result)).toMatchObject({ value: "100", formula: "F12 / F30", operands: ["F12", "F30"] })
	})

	test("expr refuses unsupported tokens and absent ids", () => {
		const ledger = fixture()
		for (const formula of ["F12 ** 2", "Math.max(F12)", "F12 / F404", "F12 / 0", "(F12"]) {
			expect(derive(ledger, { op: "expr", formula, rationale: "r" }).error).toBeDefined()
		}
		expect(ledger.rows).toHaveLength(9)
	})

	test("ratio of 1.00 / 3.00 stores 1/3 and chains exactly through expr", () => {
		const ledger = ledgerOf([measured("F5", "1.00", EOK_WON, { population: "all" }), measured("F6", "3.00", EOK_WON, { population: "all" })])
		const ratio = rowOf(derive(ledger, { op: "ratio", num: "F5", den: "F6" }))
		expect(ratio.exact).toEqual({ num: "1", den: "3" })
		expect(ratio.value).toBe("0.333")
		const chained = rowOf(derive(ledger, { op: "expr", formula: `${ratio.fact_id} * 3`, rationale: "undo the ratio" }))
		expect(chained.exact).toEqual({ num: "1", den: "1" })
		expect(chained.value).toBe("1")

		const dir = mkdtempSync(join(tmpdir(), "ulw-derive-"))
		onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
		writeLedger(dir, ledger)
		const back = readLedger(dir) as Ledger
		expect(back.rows.find((row) => row.fact_id === ratio.fact_id)?.exact).toEqual({ num: "1", den: "3" })
		expect(recompute(back, back.rows.find((row) => row.fact_id === chained.fact_id) as Row).ok).toBe(true)
	})
})

describe("recompute", () => {
	test("an untouched row recomputes; an edited value or exact does not", () => {
		const ledger = fixture()
		const row = rowOf(derive(ledger, { op: "convert", operands: ["F12"], to: "mm" }))
		expect(recompute(ledger, row)).toMatchObject({ ok: true, expected: { value: "320000", exact: { num: "320000", den: "1" } } })
		expect(recompute(ledger, { ...row, value: "319999" }).ok).toBe(false)
		expect(recompute(ledger, { ...row, exact: { num: "319999", den: "1" } }).ok).toBe(false)
		const sum = rowOf(derive(ledger, { op: "sum", operands: ["F5", "F6"], unit: EOK_WON }))
		expect(recompute(ledger, sum).ok).toBe(true)
		expect(recompute(ledger, { ...sum, exact: { num: "301", den: "1" } }).ok).toBe(false)
	})
})
