/// <reference types="bun-types" />
import { describe, expect, onTestFinished, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { claimChecks } from "./fidelity-claims.mjs"
import { traceChecks } from "./fidelity-trace.mjs"
import { fill } from "./fact-fill.mjs"
import { buildContext, checkStatic } from "./gates-static.mjs"
import { parseHtml } from "./html-lite.mjs"
import { initManifest } from "./outcome.mjs"

const START = "2026-10-25T12:52:01.832Z"
const FIX = join(import.meta.dir, "tests/fixtures/fidelity")
const LEDGER = JSON.parse(readFileSync(join(FIX, "ledger-basic.json"), "utf8"))
const cli = join(import.meta.dir, "report-tools.mjs")

function directory(name = "E") {
	const root = mkdtempSync(join(tmpdir(), "t18-contract-"))
	onTestFinished(() => rmSync(root, { recursive: true, force: true }))
	const dir = join(root, name)
	mkdirSync(dir)
	return dir
}

function init(dir: string) {
	return spawnSync(process.execPath, [cli, "outcome", "init", "--session-dir", dir, "--promised", "html", "--now", START], { encoding: "utf8" })
}

describe("task 18 outcome clock", () => {
	test("E with existing terminal metadata initializes using the run clock", () => {
		const dir = directory()
		writeFileSync(join(dir, "terminal-state.json"), JSON.stringify({ started_at: START }))
		const result = init(dir)
		expect(result.status).toBe(0)
		expect(JSON.parse(readFileSync(join(dir, "outcome.json"), "utf8")).startedAt).toBe(START)
	})

	test("E without metadata refuses and names the missing run timestamp", () => {
		const result = init(directory())
		expect(result.status).toBe(1)
		expect(result.stderr).toMatch(/terminal-state\.json.*started_at/)
	})

	test("legacy timestamp basename remains accepted without metadata", () => {
		const dir = directory("20260101-120000")
		expect(init(dir).status).toBe(0)
		expect(JSON.parse(readFileSync(join(dir, "outcome.json"), "utf8")).startedAt).toMatch(/^2026-01-01T/)
	})

	test("metadata overrides a timestamp basename and survives reinitialization", () => {
		const dir = directory("20260101-120000")
		writeFileSync(join(dir, "outcome.json"), JSON.stringify({ startedAt: START }))
		expect(initManifest({ sessionDir: dir, promised: [], lane: null }).startedAt).toBe(START)
	})

	test("an invalid metadata timestamp never falls back to a plausible basename", () => {
		const dir = directory("20260101-120000")
		writeFileSync(join(dir, "terminal-state.json"), JSON.stringify({ started_at: "not-a-time" }))
		expect(init(dir).status).toBe(1)
	})
})

describe("task 18 derived placeholder", () => {
	test("documented D:F12:label fills and renders its derived claim attribute", () => {
		const row = { ...LEDGER.rows.find((r: { fact_id: string }) => r.fact_id === "F40"), fact_id: "F12", label: "label" }
		const result = fill("<p>{{D:F12:label}}</p>", { rows: [row] })
		expect(result.errors).toEqual([])
		expect(result.out).toContain('data-claim-kind="derived"')
		expect(result.out).toContain('data-fact="F12"')
		expect(result.out).toContain("320000 mm</data>")
	})

	test("malformed D placeholders retain unresolved_placeholder", () => {
		for (const token of ["{{D:F12}}", "{{D:Q7:label}}", "{{D:F12:label:value}}", "{{D:F12:}}", "{{D:F12:a:b}}"]) {
			const result = fill(token, LEDGER)
			expect(result.out).toBeNull()
			expect((result.errors as { code: string }[]).map((e) => e.code)).toEqual(["unresolved_placeholder"])
		}
	})
})

function checks(body: string) {
	const doc = parseHtml(`<h2>Official sources</h2>${body}`)
	const ctx = buildContext(doc, {})
	const found = (checkStatic(doc).defects as { code: string }[]).map((d) => d.code)
	const flag = (code: string) => found.push(code)
	claimChecks(ctx, new Map(), () => undefined, flag)
	traceChecks(ctx, new Map(), null, flag, () => false)
	return found
}

describe("task 18 Sources scope", () => {
	test("a numeric claim sentence under Sources is checked by static and fidelity gates", () => {
		const found = checks("<p>We confirmed that the rate is 42%.</p>")
		expect(found).toContain("unsourced_number")
		expect(found).toContain("untraceable_number")
	})

	test("an existing run cue under Sources emits verification_claim_unmarked", () => {
		expect(checks("<p>We ran the check and it reported 42%.</p>")).toContain("verification_claim_unmarked")
	})

	test("citation tags links and title-plus-URL list items keep their years exempt", () => {
		for (const citation of [
			'<p>[S4] Annual report, 2024. https://example.com/report</p>',
			'<p><a href="https://example.com/2024">Annual report 2024</a></p>',
			'<li>Annual report 2024, https://example.com/report</li>',
			'<li>Annual report 2024, <a href="https://example.com/report">source</a></li>',
		]) {
			const found = checks(citation)
			expect(found).not.toContain("unsourced_number")
			expect(found).not.toContain("untraceable_number")
			expect(found).not.toContain("verification_claim_unmarked")
		}
	})

	test("a citation followed by prose in the same block never hides the claim", () => {
		const found = checks('<p>[S4] Annual report 2024, https://example.com/report<br>We ran the check and found 42%.</p>')
		expect(found).toContain("verification_claim_unmarked")
		expect(found).toContain("untraceable_number")
	})
})
