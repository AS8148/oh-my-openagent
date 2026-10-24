import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { CLAIM_ATTRIBUTE, CLAIM_KINDS, CLAIM_TABLE_BEGIN, CLAIM_TABLE_END, renderClaimKindTable, unmarkedKinds } from "./claim-kinds.mjs"
import { DEFECT_CODES } from "./contracts.mjs"
import { valueChecks } from "./fidelity-values.mjs"
import { buildContext } from "./gates-static.mjs"
import { parseHtml } from "./html-lite.mjs"

// Protects the claim-kind contract the writer (fill) and the gate share: a sentence marked with a
// claim kind must cite a row that kind accepts, and the doc table writers read is rendered from it.

type Defect = { code: string; severity: string }
type Row = Record<string, unknown> & { fact_id: string; kind: string; source_id: string | null }

const FIX = join(import.meta.dir, "tests", "fixtures", "fidelity")
const BASE: { rows: Row[] } = JSON.parse(readFileSync(join(FIX, "ledger-verify.json"), "utf8"))
const F8 = BASE.rows.find((row) => row.fact_id === "F8") as Row
const ASSUMED: Row = { ...F8, fact_id: "F9", kind: "assumed", label: "growth_rate", raw: "15%", value: "15", unit: "%", render: null, exact: { num: "15", den: "1" }, operation: null, operands: [], derived_from: [], formula: null, factor: null, rationale: "planning assumption" }
const LEDGER = { ...BASE, rows: [...BASE.rows, ASSUMED] }
const SOURCE_KIND: Record<string, string> = { S4: "page", S5: "command" }

const run = (body: string) => valueChecks(buildContext(parseHtml(`<h2>Findings</h2>\n${body}`), { baseDir: FIX }), LEDGER, null, join(FIX, "sources"), {}) as Defect[]

function rowsFor(kind: string) {
	const entry = CLAIM_KINDS[kind]
	const fits = (row: Row) => entry.rowKinds.includes(row.kind) && (entry.sourceKinds === null || entry.sourceKinds.includes(SOURCE_KIND[row.source_id ?? ""]))
	return { ok: LEDGER.rows.find(fits), bad: LEDGER.rows.find((row) => !fits(row)) }
}

const cite = (row: Row, kind: string) =>
	row.kind === "quote"
		? `<p>They wrote <q data-fact="${row.fact_id}" ${CLAIM_ATTRIBUTE}="${kind}" data-quote-sel="full">${row.quote}</q> [${row.source_id ?? "S4"}].</p>`
		: `<p>The figure is <data class="fact" ${CLAIM_ATTRIBUTE}="${kind}" data-fact="${row.fact_id}">${row.raw}</data> [${row.source_id ?? "S4"}].</p>`

describe("every claim kind is enforced from CLAIM_KINDS", () => {
	for (const kind of Object.keys(CLAIM_KINDS)) {
		const { ok, bad } = rowsFor(kind)
		test(`#given ${kind} marked on a row it accepts (${ok?.fact_id}) #when checked #then no defect`, () => {
			expect(ok).toBeDefined()
			expect(run(cite(ok as Row, kind))).toEqual([])
		})
		test(`#given ${kind} marked on a row it refuses (${bad?.fact_id}) #when checked #then ${CLAIM_KINDS[kind].defect}`, () => {
			expect(bad).toBeDefined()
			expect(run(cite(bad as Row, kind)).map((d) => d.code)).toContain(CLAIM_KINDS[kind].defect)
		})
	}

	test("#given an unknown claim kind #when checked #then claim_kind_mismatch", () => {
		expect(run(cite(LEDGER.rows[0], "rumoured")).map((d) => d.code)).toEqual(["claim_kind_mismatch"])
	})

	test("#given every defect and warning code the table names #then contracts defines it, and warnings are never major", () => {
		for (const entry of Object.values(CLAIM_KINDS) as { defect: string; unmarked: { code: string } | null }[]) {
			expect(DEFECT_CODES[entry.defect]).toBeDefined()
			if (entry.unmarked) expect(DEFECT_CODES[entry.unmarked.code].severity).toBe("minor")
		}
	})
})

describe("unmarked phrases", () => {
	const fires = ["We verified the span by running the measurement script.", "We ran the suite twice.", "We executed the export.", "We verified by hand-counting the rows.", "실행해 확인한 길이", "스크립트를 실행하여 검증한 값", "직접 실행한 결과"]
	const quiet = ["The tests showed a 12 % drop.", "The bridge, which ran across the river, spans 320 m.", "The span, as confirmed with the annual inspection report, is 320 m.", "Clinical tests confirmed the diagnosis.", "확인된 길이는 최대 320 m"]
	for (const text of fires) test(`#given "${text}" #then verified`, () => expect(unmarkedKinds(text)).toEqual(["verified"]))
	for (const text of quiet) test(`#given "${text}" #then nothing`, () => expect(unmarkedKinds(text)).toEqual([]))
})

describe("references/fidelity-claim-kinds.md is rendered from CLAIM_KINDS", () => {
	const doc = readFileSync(join(import.meta.dir, "..", "references", "fidelity-claim-kinds.md"), "utf8")

	test("the committed table section equals renderClaimKindTable() byte for byte", () => {
		const [begin, end] = [doc.indexOf(CLAIM_TABLE_BEGIN), doc.indexOf(CLAIM_TABLE_END)]
		expect(begin).toBeGreaterThanOrEqual(0)
		expect(end).toBeGreaterThan(begin)
		expect(doc.slice(begin + CLAIM_TABLE_BEGIN.length + 1, end)).toBe(renderClaimKindTable())
	})

	test("node claim-kinds.mjs --render-doc prints the same table", () => {
		const result = spawnSync("node", [join(import.meta.dir, "claim-kinds.mjs"), "--render-doc"], { encoding: "utf8" })
		expect(result.status).toBe(0)
		expect(result.stdout).toBe(renderClaimKindTable())
	})
})
