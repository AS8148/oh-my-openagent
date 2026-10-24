// Architecture contract for the polish command (#11160 sweep): the edit contract, the ledger
// loader, the edition-format grammar, and the severity buckets each have one owner export, so a
// reintroduced local copy in fact-commands-polish.mjs fails one of these tests.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { CliError } from "./cli-support.mjs"
import { countDefects, DEFECT_CODES, SEVERITIES } from "./contracts.mjs"
import { runFactMeaning } from "./fact-commands-meaning.mjs"
import * as polishCommand from "./fact-commands-polish.mjs"
import { editionFormatOf, ledgerFrom, sessionOf } from "./fact-commands-verify.mjs"
import { applyEdits, POLISH_EDIT_FIELDS, validatePolishEdits } from "./polish-apply.mjs"

const { polishDiffFails, runFactPolish } = polishCommand
const source = (name: string) => readFileSync(join(import.meta.dir, name), "utf8")
const LEDGER = { schemaVersion: 1, rows: [], events: [] }
const doc = (body: string) => `<html><body>\n${body}\n</body></html>`
const BRIEF = join(import.meta.dir, "tests", "fixtures", "fidelity-brief-locked.md")

const dir = mkdtempSync(join(tmpdir(), "polish-copy-returns-"))
const file = (name: string, content: string) => {
	const path = join(dir, name)
	writeFileSync(path, content)
	return path
}
const ledgerPath = file("ledger.json", JSON.stringify(LEDGER))
const badLedgerPath = file("bad-ledger.json", JSON.stringify({ schemaVersion: 1, rows: "nope" }))
const reportPath = file("report.html", doc("<p>The span is 320 m [S1].</p>"))
const savedSession = process.env.SESSION_DIR
beforeEach(() => {
	delete process.env.SESSION_DIR
})
afterEach(() => {
	if (savedSession === undefined) delete process.env.SESSION_DIR
	else process.env.SESSION_DIR = savedSession
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function outcome(run: () => unknown) {
	try {
		run()
		return "ok"
	} catch (error) {
		if (!(error instanceof CliError)) throw error
		return error.message
	}
}

describe("the polish edit contract is polish-apply's", () => {
	const SHAPES = [
		["not an array", { before: "a", after: "b" }],
		["a null edit", [null]],
		["an array edit", [["a", "b"]]],
		["a missing after", [{ before: "span" }]],
		["a numeric before", [{ before: 3, after: "b" }]],
		["a numeric reason", [{ before: "span", after: "span", reason: 5 }]],
		["a valid edit", [{ before: "The span is", after: "The span is", reason: "none" }]],
		["a valid edit without reason", [{ before: "The span is", after: "The span is" }]],
	] as const

	test("#given the command module #when its edit contract is read #then it is the polish-apply export", () => {
		expect(polishCommand.validatePolishEdits).toBe(validatePolishEdits)
		expect(polishCommand.POLISH_EDIT_FIELDS).toBe(POLISH_EDIT_FIELDS)
		expect(source("fact-commands-polish.mjs")).not.toMatch(/typeof edit\?\.(before|after)/u)
	})

	for (const [name, edits] of SHAPES) {
		test(`#given ${name} #when applied directly and through the CLI #then both accept or both refuse`, () => {
			const editsPath = file(`edits-${name.replaceAll(" ", "-")}.json`, JSON.stringify(edits))
			const direct = (() => {
				try {
					applyEdits(readFileSync(reportPath, "utf8"), edits as never, LEDGER)
					return "ok"
				} catch (error) {
					expect(error).toBeInstanceOf(TypeError)
					return "refused"
				}
			})()
			const cli = outcome(() => runFactPolish("polish-apply", [reportPath, "--edits", editsPath, "--ledger", ledgerPath, "--out", join(dir, "out.html")]))
			expect(cli === "ok" ? "ok" : "refused").toBe(direct)
			if (cli !== "ok") expect(cli).toContain(editsPath)
		})
	}
})

describe("the ledger loader is one shared helper", () => {
	const pairs = (extra: string[]) => () => runFactMeaning("pairs", [reportPath, "--brief", BRIEF, "--out", join(dir, "pairs.json"), ...extra])
	const diff = (extra: string[]) => () => runFactPolish("polish-diff", ["--before", reportPath, "--after", reportPath, ...extra])

	test("#given the command modules #when read #then neither defines its own ledger loader or session resolver", () => {
		expect(polishCommand.ledgerFrom).toBe(ledgerFrom)
		for (const name of ["fact-commands-meaning.mjs", "fact-commands-polish.mjs"]) {
			const text = source(name)
			expect(text, name).not.toMatch(/function (readLedgerFrom|ledgerFrom)\b|validateLedger\(/u)
			expect(text, name).not.toMatch(/const sessionOf\s*=/u)
		}
	})

	test("#given the same valid, invalid, and missing ledgers #when fact pairs and fact polish-diff load them #then both give the same outcome", () => {
		for (const extra of [["--ledger", ledgerPath], ["--ledger", badLedgerPath], []]) {
			const expected = outcome(() => ledgerFrom({ ...(extra.length > 0 ? { ledger: extra[1] } : {}) }))
			expect(outcome(pairs(extra)), extra.join(" ")).toBe(expected)
			expect(outcome(diff(extra)), extra.join(" ")).toBe(expected)
		}
		expect(outcome(() => ledgerFrom({ ledger: badLedgerPath }))).toContain("is not a valid fact ledger")
		expect(outcome(() => ledgerFrom({}))).toContain("--ledger is required")
	})

	test("#given a session dir flag or SESSION_DIR #when resolved #then the flag wins and a bare flag is no session", () => {
		expect(sessionOf({ "session-dir": dir })).toBe(dir)
		expect(sessionOf({ "session-dir": true })).toBeNull()
		process.env.SESSION_DIR = dir
		expect(sessionOf({})).toBe(dir)
	})
})

describe("the edition format comes from verify's grammar", () => {
	test("#given report paths of each case #when polish-apply reads them #then it refuses exactly the Markdown classifications", () => {
		const editsPath = file("edits-ok.json", "[]")
		expect(source("fact-commands-polish.mjs")).not.toMatch(/md\|markdown/u)
		for (const name of ["r.md", "R.MD", "r.markdown", "R.Markdown", "r.html", "r.HTML"]) {
			const path = file(name, readFileSync(reportPath, "utf8"))
			const result = outcome(() => runFactPolish("polish-apply", [path, "--edits", editsPath, "--ledger", ledgerPath, "--out", join(dir, "out.html")]))
			expect(result.includes("takes the filled HTML edition"), name).toBe(editionFormatOf(path, undefined) === "md")
		}
	})
})

describe("polish-diff counts with contracts and exits on blockers only", () => {
	type DiffRun = { exitCode: number; json: { counts: Record<string, number>; defects: { severity: string }[] } }
	const run = (before: string, after: string) => runFactPolish("polish-diff", ["--before", file("b.html", doc(before)), "--after", file("a.html", doc(after)), "--ledger", ledgerPath]) as unknown as DiffRun

	test("#given every registry code #when polishDiffFails classifies it #then only registry blockers fail", () => {
		for (const [code, entry] of Object.entries(DEFECT_CODES) as [string, { severity: string }][]) expect(polishDiffFails([{ code, severity: "minor" }]), code).toBe(entry.severity === "blocker")
		expect(polishDiffFails([])).toBe(false)
		expect(source("fact-commands-polish.mjs")).not.toMatch(/blocker:\s*0|counts\.blocker > 0/u)
	})

	test("#given a major-only polish diff #when run #then it is reported with contract buckets and exits 0", () => {
		const result = run("<p>The span may be 320 m [S1].</p>", "<p>The span is 320 m [S1].</p>")
		const { defects } = result.json
		expect(defects.length).toBeGreaterThan(0)
		expect(defects.every((defect) => defect.severity === "major")).toBe(true)
		expect(result.json.counts).toEqual(countDefects(defects))
		expect(Object.keys(result.json.counts)).toEqual([...SEVERITIES, "total"])
		expect(result.exitCode).toBe(0)
	})

	test("#given a changed numeral #when run #then the blocker exits 1", () => {
		const result = run("<p>Throughput grew 3.5 times [S1].</p>", "<p>Throughput grew 35 times [S1].</p>")
		expect(result.json.counts).toEqual(countDefects(result.json.defects))
		expect(result.exitCode).toBe(1)
	})
})
