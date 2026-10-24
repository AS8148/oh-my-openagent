import { describe, expect, onTestFinished, test } from "bun:test"
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { derive, recompute } from "./fact-derive.mjs"
import { LEDGER_FILENAME, addRow, emptyLedger, readLedger, validateLedger, writeLedger } from "./fact-ledger.mjs"

// Written by dev's pre-registry addRow: no context/precision/compatibility columns, alias units as given.
const FIXTURE = join(import.meta.dir, "tests", "fixtures", "fidelity", "ledger-legacy-dev.json")

type Row = Record<string, unknown>
type Ledger = { schemaVersion: number; rows: Row[]; events: unknown[] }

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ulw-legacy-"))
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
	return dir
}

const fixture = (): Ledger => JSON.parse(readFileSync(FIXTURE, "utf8"))
const rowOf = (ledger: Ledger, id: string): Row => ledger.rows.find((row) => row.fact_id === id) as Row

function loaded(): { dir: string; ledger: Ledger } {
	const dir = tempDir()
	copyFileSync(FIXTURE, join(dir, LEDGER_FILENAME))
	return { dir, ledger: readLedger(dir) as Ledger }
}

describe("ledgers written before the unit registry (dimension 31)", () => {
	test("#given dev's ledger #when validated #then it has no errors", () => {
		expect(validateLedger(fixture())).toEqual([])
	})

	test("#given dev's ledger #when read #then source units are canonical and missing columns read as null", () => {
		const { ledger } = loaded()
		expect(["F1", "F2", "F3", "F4", "F5", "F6", "F7"].map((id) => rowOf(ledger, id).unit)).toEqual(["km", "km", "%", "%p", "person", "KRW-e3", "%"])
		for (const id of ["F1", "Q1", "F7"]) {
			for (const column of ["context", "precision", "compatibility"]) expect(rowOf(ledger, id)[column]).toBeNull()
		}
		for (const id of ["F8", "F9"]) expect(Object.hasOwn(rowOf(ledger, id), "precision")).toBe(false)
	})

	test("#given dev's ledger #when two alias-unit measured rows are summed #then the new row is canonical", () => {
		for (const ledger of [fixture(), loaded().ledger]) {
			const result = derive(ledger, { op: "sum", operands: ["F1", "F2"], unit: "km" })
			expect(result.error).toBeUndefined()
			expect(result.row).toMatchObject({ kind: "derived", unit: "km", value: "21", exact: { num: "41", den: "2" }, compatibility: "checked" })
			expect(validateLedger(ledger)).toEqual([])
			expect(recompute(ledger, result.row).ok).toBe(true)
		}
	})

	test("#given a legacy derived or converted row #when recomputed #then it reports a legacy derived row", () => {
		const ledger = fixture()
		for (const id of ["F8", "F9"]) {
			const result = recompute(ledger, rowOf(ledger, id))
			expect(result.ok).toBe(false)
			expect(result.shape).toBe("legacy derived row")
		}
	})

	test("#given a legacy derived row #when used as an operand #then derive refuses it with the same shape", () => {
		const ledger = fixture()
		const before = ledger.rows.length
		const result = derive(ledger, { op: "sum", operands: ["F8", "F2"], unit: "km" })
		expect(result.error).toBe("incompatible_operands")
		expect(result.shape).toBe("legacy derived row")
		expect(ledger.rows.length).toBe(before)
	})

	test("#given dev's ledger #when read and written #then source rows are rewritten once and legacy rows stay legacy", () => {
		const { dir, ledger } = loaded()
		writeLedger(dir, ledger)
		const once = readFileSync(join(dir, LEDGER_FILENAME), "utf8")
		const written = JSON.parse(once) as Ledger
		expect(rowOf(written, "F1").unit).toBe("km")
		expect(rowOf(written, "F1").precision).toBeNull()
		expect(Object.hasOwn(rowOf(written, "F8"), "precision")).toBe(false)
		writeLedger(dir, readLedger(dir))
		expect(readFileSync(join(dir, LEDGER_FILENAME), "utf8")).toBe(once)
	})

	test("#given a ledger written by this version #when read and written #then it is unchanged", () => {
		const dir = tempDir()
		const ledger = emptyLedger() as Ledger
		const source = { kind: "measured", raw: "", quote: "", source_id: "S1", locator: { artifact: "sources/S1/text.txt", char_start: 0, char_end: 4 }, snapshot_sha256: "b".repeat(64), extracted_by: "fact add --find", observed_at: "2026-10-23T08:00:00Z" }
		addRow(ledger, { ...source, value: "3", unit: "kilometers", label: "a" })
		addRow(ledger, { ...source, value: "4", unit: "km", label: "b" })
		expect(derive(ledger, { op: "sum", operands: ["F1", "F2"], unit: "km" }).error).toBeUndefined()
		writeLedger(dir, ledger)
		const first = readFileSync(join(dir, LEDGER_FILENAME), "utf8")
		writeLedger(dir, readLedger(dir))
		expect(readFileSync(join(dir, LEDGER_FILENAME), "utf8")).toBe(first)
		expect(readLedger(dir)).toEqual(JSON.parse(first))
	})
})
