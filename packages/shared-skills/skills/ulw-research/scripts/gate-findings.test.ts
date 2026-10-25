import { describe, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DEFECT_CODES } from "./contracts.mjs"
import { fill } from "./fact-fill.mjs"
import { markdownAsHtml, runFactVerify } from "./fact-commands-verify.mjs"
import { valueChecks } from "./fidelity-values.mjs"
import { buildContext } from "./gates-static.mjs"
import { parseHtml } from "./html-lite.mjs"
import { checkFidelity } from "./gates-fidelity.mjs"
import { sha256Of } from "./cli-support.mjs"
import { snapshotsReadable } from "./fidelity-snapshot-readability.mjs"

const FIX = join(import.meta.dir, "tests/fixtures/fidelity")
const BASE = JSON.parse(readFileSync(join(FIX, "ledger-verify.json"), "utf8"))
const row = (id: string) => BASE.rows.find((r: { fact_id: string }) => r.fact_id === id)
const check = (html: string, ledger = BASE, sources = join(FIX, "sources")) =>
	valueChecks(buildContext(parseHtml(`<h2>Findings</h2>${html}`), { baseDir: FIX }), ledger, null, sources)
const data = (id: string, shown: string) => `<p><data data-fact="${id}">${shown}</data></p>`

describe("H2 unreadable source snapshots fail closed", () => {
	for (const missing of ["directory", "meta.json", "text.txt", "invalid metadata", "unreadable body", "raw.bin"]) {
		test(`H2 ${missing} blocks every source-backed row`, () => {
			const dir = mkdtempSync(join(tmpdir(), "gate-findings-"))
			try {
				cpSync(join(FIX, "sources"), dir, { recursive: true })
				if (missing === "directory") rmSync(dir, { recursive: true })
				else if (missing === "invalid metadata") writeFileSync(join(dir, "S4/meta.json"), "{")
				else if (missing === "unreadable body") {
					rmSync(join(dir, "S4/text.txt"))
					mkdirSync(join(dir, "S4/text.txt"))
				} else if (missing !== "raw.bin") rmSync(join(dir, "S4", missing))
				const ledger = structuredClone(BASE)
				if (missing === "raw.bin") {
					for (const r of ledger.rows.filter((r: { source_id: string }) => r.source_id === "S4")) r.locator = { ...r.locator, artifact: "raw.bin", unit: "utf8-bytes" }
				}
				const defects = check(data("F1", "up to 320 m") + data("F2", "1,237"), ledger, dir)
				expect(defects.filter((d: { code: string }) => d.code === "snapshot_hash_mismatch").map((d: { fact_id: string }) => d.fact_id).sort()).toEqual(["F1", "F2"])
				expect(DEFECT_CODES.snapshot_hash_mismatch).toMatchObject({ severity: "blocker", integrity: true })
			} finally {
				rmSync(dir, { recursive: true, force: true })
			}
		})
	}
	test("H2 source-free assumptions and intact snapshots remain valid", () => {
		expect(check(data("F2", "1,237"))).toEqual([])
		expect(check(data("F8", row("F8").render))).toEqual([])
		const assumed = { ...row("F8"), kind: "assumed", raw: "15%", value: "15", unit: "%", derived_from: [] }
		expect(check('<data data-fact="F8" data-claim-kind="assumed">15%</data>', { ...BASE, rows: [assumed] }, "nonexistent")).toEqual([])
	})
	test("H2 raw-body and explicit converted-only readers preserve their source contract", () => {
		const dir = mkdtempSync(join(tmpdir(), "gate-raw-"))
		try {
			mkdirSync(join(dir, "S1"))
			const ctx = buildContext(parseHtml(data("F1", "42")), { baseDir: FIX })
			const cited = new Map([["F1", ctx.body]])
			for (const kind of ["command", "converted-only"]) {
				const body = kind === "command" ? "raw command body" : "converted quote"
				const file = kind === "command" ? "raw.bin" : "text.txt"
				writeFileSync(join(dir, "S1", file), body)
				writeFileSync(join(dir, "S1/meta.json"), JSON.stringify({ kind, sha256: sha256Of(body) }))
				const rows = new Map([["F1", { fact_id: "F1", source_id: "S1", kind: "quote", locator: { unit: "utf8-bytes" } }]])
				const defects: object[] = []
				expect(snapshotsReadable(ctx, rows, cited, dir, defects)).toBe(true)
				expect(defects).toEqual([])
				rmSync(join(dir, "S1", file))
			}
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
	test("H2 fact verify returns exit 1 and a blocking record for missing sources", () => {
		const dir = mkdtempSync(join(tmpdir(), "gate-verify-"))
		try {
			writeFileSync(join(dir, "fact-ledger.json"), JSON.stringify(BASE))
			cpSync(join(FIX, "../fidelity-brief-locked.md"), join(dir, "brief.md"))
			const report = join(dir, "report.html")
			writeFileSync(report, data("F1", "up to 320 m") + data("F2", "1,237"))
			const result = runFactVerify({ positionals: [report], flags: { "session-dir": dir, sources: join(dir, "nonexistent") } })
			expect(result.exitCode).toBe(1)
			if (!("defects" in result.json)) throw new Error("missing verification record")
			expect(result.json.defects.filter((d) => "code" in d && d.code === "snapshot_hash_mismatch").map((d) => "fact_id" in d ? d.fact_id : null).sort()).toEqual(["F1", "F2"])
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})

describe("H1 converted originals bind both halves", () => {
	for (const [shown, code] of [["320,000 mm (320 mm)", "unit_mismatch"], ["320,000 mm (999 m)", "value_mismatch"]]) {
		test(`H1 original tamper ${code}`, () => {
			expect(check(data("F8", shown))).toContainEqual(expect.objectContaining({ code, part: "original" }))
			const brief = readFileSync(join(FIX, "../fidelity-brief-locked.md"), "utf8")
			expect(checkFidelity(data("F8", shown), { ledger: BASE, brief }).defects).toContainEqual(expect.objectContaining({ code, part: "original" }))
		})
	}
	test("H1 original must remain bound even if the ledger render was changed", () => {
		const ledger = structuredClone(BASE)
		ledger.rows.find((r: { fact_id: string }) => r.fact_id === "F8").render = "320,000 mm (999 m)"
		expect(check(data("F8", "320,000 mm (999 m)"), ledger)).toContainEqual(expect.objectContaining({ code: "value_mismatch", part: "original" }))
	})
	test("H1 untampered and bracket-free custom renders verify the converted half", () => {
		expect(check(data("F8", "320,000 mm (320 m)"))).toEqual([])
		expect(check(data("F8", "Converted: 320,000 mm"))).toEqual([])
		expect(check(data("F8", "319,000 mm (320 m)"))).toContainEqual(expect.objectContaining({ code: "value_mismatch" }))
		expect(check(data("F8", "320,000 mm (320 m"))).toContainEqual(expect.objectContaining({ code: "value_mismatch", part: "original" }))
	})
	test("H1 grouped and percent originals retain the operation display contract", () => {
		const ledger = structuredClone(BASE)
		const input = ledger.rows.find((r: { fact_id: string }) => r.fact_id === "F1")
		const converted = ledger.rows.find((r: { fact_id: string }) => r.fact_id === "F8")
		input.value = "1237"
		converted.value = "1237000"
		expect(check(data("F8", "1,237,000 mm (1,237 m)"), ledger)).toEqual([])
		converted.kind = "derived"
		converted.value = "0.12"
		converted.unit = null
		converted.derived_from = ["F3"]
		expect(check(data("F8", "0.12 (12%)"), ledger)).toEqual([])
	})
})

describe("H3 documented claim prefixes fill and verify", () => {
	const assumed = { ...row("F8"), fact_id: "F9", kind: "assumed", label: "plan", raw: "15%", value: "15", unit: "%", render: null, derived_from: [], operands: [], operation: null }
	const quote = { ...row("Q1"), fact_id: "Q2", label: "command", source_id: "S5", locator: row("F7").locator }
	const ledger = { ...BASE, rows: [...BASE.rows, assumed, quote] }
	for (const [token, kind] of [["{{V:F7:tests_passed}}", "verified"], ["{{A:F9:plan}}", "assumed"], ['{{V:Q2:command:from="no earlier":to="2027"}}', "verified"], ["{{D:F8:span_mm}}", "derived"]]) {
		for (const format of ["html", "md"] as const) {
			test(`H3 ${token} fills ${format} with ${kind} binding`, () => {
				const actual = token.replace("tests_passed", row("F7").label)
				const result = fill(format === "html" ? `<p>${actual}</p>` : actual, ledger, { format })
				expect(result.errors).toEqual([])
				expect(result.out).not.toBeNull()
				if (result.out === null) throw new Error("fill failed")
				const html = format === "html" ? result.out : markdownAsHtml(result.out, result.fillMap as Parameters<typeof markdownAsHtml>[1], ledger).html
				expect(html).toContain(`data-claim-kind="${kind}"`)
				expect(check(html, ledger).filter((d: { code: string }) => ["claim_kind_mismatch", "unsupported_verification"].includes(d.code))).toEqual([])
			})
		}
	}
	test("H3 unsupported row kinds and malformed prefixes never fill", () => {
		for (const token of ["{{A:F8:span_mm}}", "{{V:F8:span_mm}}", "{{A:}}", "{{V:F7}}", "{{X:F8:span_mm}}", "{{V:V:F7:tests_passed}}"]) {
			const result = fill(token, ledger)
			expect(result.out).toBeNull()
			expect(result.errors[0]).toMatchObject({ code: "unresolved_placeholder" })
		}
	})
})
