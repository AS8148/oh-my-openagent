import { describe, expect, onTestFinished, test } from "bun:test"
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { run } from "./report-tools.mjs"

const FIX = join(import.meta.dir, "tests", "fixtures")
const LEDGER = JSON.parse(readFileSync(join(FIX, "fidelity", "ledger-verify.json"), "utf8"))
type VerifyResult = { exitCode: number; json: { defects: { code: string; severity: string }[] } }

async function filled(body: string, format = "html") {
	const dir = mkdtempSync(join(tmpdir(), "value-mode-unit-"))
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
	writeFileSync(join(dir, "fact-ledger.json"), JSON.stringify(LEDGER))
	copyFileSync(join(FIX, "fidelity-brief-locked.md"), join(dir, "brief.md"))
	const source = join(dir, `report.src.${format}`)
	const report = join(dir, `report.${format}`)
	writeFileSync(source, body)
	const result = await run(["fact", "fill", source, "--out", report, "--session-dir", dir])
	expect(result.exitCode).toBe(0)
	const verify = async () => await run(["fact", "verify", report, "--session-dir", dir]) as VerifyResult
	return { report, verify }
}

const codes = (result: { json: { defects: { code: string }[] } }) => result.json.defects.map((d) => d.code)
const prose = (tail: string) => `<h2>Findings</h2><p>Up to {{F1:span_len:value}}${tail} [S4].</p>`

describe("value-mode unit binding through fact fill and verify", () => {
	for (const format of ["html", "md"]) {
		test(`#given ${format} value mode followed by meters #when edited to mm #then verify fails unit_mismatch`, async () => {
			const body = format === "html" ? prose(" meters") : "## Findings\n\nUp to {{F1:span_len:value}} meters [S4]."
			const { report, verify } = await filled(body, format)
			expect((await verify()).exitCode).toBe(0)
			writeFileSync(report, readFileSync(report, "utf8").replace(" meters", " mm"))
			const edited = await verify()
			expect(codes(edited)).toContain("unit_mismatch")
			expect(edited.exitCode).toBe(1)
		})
	}

	test("#given no following unit #when verified #then unit_unbound is a minor warning", async () => {
		const { verify } = await filled(prose(" long"))
		const result = await verify()
		expect(result.exitCode).toBe(0)
		expect(result.json.defects).toContainEqual(expect.objectContaining({ code: "unit_unbound", severity: "minor" }))
	})

	test("#given a matching table unit header #when value mode has no suffix #then it is bound", async () => {
		const { verify } = await filled("<table><tr><th>Span (meters)</th></tr><tr><td>{{F1:span_len:value}}</td></tr></table>")
		expect(codes(await verify())).not.toContain("unit_unbound")
		expect((await verify()).exitCode).toBe(0)
	})

	test("#given a table unit header #when a conflicting suffix is present #then it still fails", async () => {
		const { verify } = await filled("<table><tr><th>Span (m)</th></tr><tr><td>{{F1:span_len:value}} mm</td></tr></table>")
		expect(codes(await verify())).toContain("unit_mismatch")
	})

	test("#given a wrong table header unit #when no suffix follows #then unit_mismatch", async () => {
		const { verify } = await filled("<table><tr><th>Span (mm)</th></tr><tr><td>{{F1:span_len:value}}</td></tr></table>")
		expect(codes(await verify())).toContain("unit_mismatch")
	})

	test("#given a unit only in another column #when verified #then unit_unbound", async () => {
		const { verify } = await filled("<table><tr><th>Span</th><th>Offset (m)</th></tr><tr><td>{{F1:span_len:value}}</td><td>unknown</td></tr></table>")
		expect(codes(await verify())).toContain("unit_unbound")
	})

	test("#given meters in another text node #when verified #then it cannot bind the value", async () => {
		const { verify } = await filled(prose(" <em>meters</em>"))
		expect(codes(await verify())).toContain("unit_unbound")
	})

	test("#given a dimensionless value #when no unit follows #then no unit warning", async () => {
		const { verify } = await filled("<p>{{F2:units_sold:value}} [S4].</p>")
		expect(codes(await verify())).not.toContain("unit_unbound")
	})
})
