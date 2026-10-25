import { expect, onTestFinished, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runFactPolish } from "./fact-commands-polish.mjs"
import { runFactVerify } from "./fact-commands-verify.mjs"
import { valueChecks } from "./fidelity-values.mjs"
import { buildContext } from "./gates-static.mjs"
import { parseHtml } from "./html-lite.mjs"
import { briefHashOf } from "./fidelity-policy.mjs"
import { parseFidelityBlock } from "./fidelity-brief.mjs"

const FIX = join(import.meta.dir, "tests", "fixtures")
const ledger = () => JSON.parse(readFileSync(join(FIX, "fidelity", "ledger-verify.json"), "utf8"))
const check = (html: string, book: ReturnType<typeof ledger>, options = {}) => valueChecks(buildContext(parseHtml(html), {}), book, null, null, options)

test("revision v1 does not match the brief's v12", () => {
	const book = ledger()
	book.rows.find((r: { fact_id: string }) => r.fact_id === "Q1").revision = "v1"
	const html = '<p><q data-fact="Q1">we estimate completion no earlier than 2027</q></p>'
	expect(check(html, book, { asOf: "v12 release" }).map((d: { code: string }) => d.code)).toContain("quote_stale_version")
	expect(check(html, book, { asOf: "v1 release" })).toEqual([])
})

test("missing operand observed_at is not a snapshot window mismatch", () => {
	const book = ledger()
	const row = book.rows.find((r: { fact_id: string }) => r.fact_id === "F8")
	row.snapshot_window = { dataset_id: "d1", start: "2026-11-01T00:00:00Z", end: "2026-12-01T00:00:00Z" }
	delete book.rows.find((r: { fact_id: string }) => r.fact_id === row.operands[0]).observed_at
	const defects = check('<p><data data-fact="F8">320,000 mm (320 m)</data></p>', book)
	expect(defects.map((d: { code: string }) => d.code)).toContain("operand_timestamp_missing")
	expect(defects.map((d: { code: string }) => d.code)).not.toContain("snapshot_mismatch")
	expect(defects.find((d: { code: string }) => d.code === "operand_timestamp_missing").message).toContain("observed_at")
})

test("polished edition retains original brief binding after brief changes", () => {
	const dir = mkdtempSync(join(tmpdir(), "polish-binding-"))
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
	const brief = readFileSync(join(FIX, "fidelity-brief-locked.md"), "utf8")
	const report = join(dir, "report.html")
	const output = join(dir, "polished.html")
	const html = '<html><body><p>The overview remains clear.</p></body></html>'
	writeFileSync(join(dir, "brief.md"), brief)
	writeFileSync(join(dir, "fact-ledger.json"), JSON.stringify({ schemaVersion: 1, rows: [], events: [] }))
	writeFileSync(report, html)
	writeFileSync(report + ".fill-map.json", JSON.stringify({ format: "html", artifact: report, entries: [], brief_sha256: briefHashOf(parseFidelityBlock(brief)) }))
	writeFileSync(join(dir, "edits.json"), "[]")
	expect(runFactPolish("polish-apply", [report, "--session-dir", dir, "--edits", join(dir, "edits.json"), "--out", output]).exitCode).toBe(0)
	writeFileSync(join(dir, "brief.md"), brief.replace("derived numbers: allowed", "derived numbers: none"))
	const result = runFactVerify({ positionals: [output], flags: { "session-dir": dir } }) as { json: { defects: { code: string }[] } }
	expect(result.json.defects.map((d: { code: string }) => d.code)).toContain("brief_changed")
	const map = JSON.parse(readFileSync(output + ".fill-map.json", "utf8"))
	expect(map.brief_sha256).toBe(briefHashOf(parseFidelityBlock(brief)))
})
