import { expect, onTestFinished, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DEFECT_CODES } from "./contracts.mjs"
import { FIDELITY_RECORDS, MEANING_RECORD } from "./fidelity-records.mjs"
import { run } from "./report-tools.mjs"

async function delivered(format = "html", codes: string[] | null = null) {
	const root = mkdtempSync(join(tmpdir(), "delivery-barrier-"))
	onTestFinished(() => rmSync(root, { recursive: true, force: true }))
	const dir = join(root, "20260101-120000")
	mkdirSync(dir)
	const path = join(dir, `report.${format}`)
	const record = join(dir, "fidelity-defects.json")
	writeFileSync(path, "<p>Report</p>")
	if (codes !== null) writeFileSync(record, JSON.stringify({
		artifact_sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
		defects: codes.map((code) => ({ code, severity: "minor", message: code })),
	}))
	const invoke = (args: string[]) => run(["outcome", ...args, "--session-dir", dir])
	await invoke(["init", "--promised", format])
	expect((await invoke(["set", format, "delivered", "--path", path, ...(codes === null ? [] : ["--verified-by", record])])).exitCode).toBe(0)
	return { dir, record, invoke }
}

// Enumerate the source registry, not a second list of today's fidelity codes.
for (const [code, entry] of Object.entries(DEFECT_CODES)) {
	if (!entry.integrity && entry.severity === "minor") continue
	test(`#given registry blocker ${code} #when verified and finished #then delivery refuses despite a demoted row`, async () => {
		const { dir, invoke } = await delivered("html", [code])
		for (const command of ["verify", "finish"]) {
			const result = await invoke([command])
			expect(result.exitCode).toBe(1)
			expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "fidelity_unresolved", codes: [code] }))
		}
		expect(JSON.parse(readFileSync(join(dir, "outcome.json"), "utf8")).finishedAt).toBeNull()
	})
}

test("#given an unknown defect code #when verified or finished #then delivery refuses with its reason", async () => {
	const { invoke } = await delivered("html", ["future_fidelity_defect"])
	for (const command of ["verify", "finish"]) {
		const result = await invoke([command])
		expect(result.exitCode).toBe(1)
		expect(JSON.stringify(result.json.problems)).toContain("unknown defect code future_fidelity_defect")
	}
})

test("#given a registry non-blocker #when verified and finished #then delivery passes", async () => {
	const entry = Object.entries(DEFECT_CODES).find(([, value]) => !value.integrity && value.severity === "minor")
	if (!entry) throw new Error("registry must have a non-blocking entry")
	const { invoke } = await delivered("html", [entry[0]])
	expect((await invoke(["verify"])).exitCode).toBe(0)
	expect((await invoke(["finish"])).exitCode).toBe(0)
})

for (const format of ["html", "pdf", "docx"]) {
	test(`#given delivered ${format} without any ledger or gate record #when verified and finished #then both refuse`, async () => {
		const { invoke } = await delivered(format)
		for (const command of ["verify", "finish"]) {
			const result = await invoke([command])
			expect(result.exitCode).toBe(1)
			expect(JSON.stringify(result.json.problems)).toContain("fidelity gate not run")
		}
	})
}

test("#given a missing gate #when explicitly skipped with a reason #then the logged choice permits delivery", async () => {
	const { dir, invoke } = await delivered()
	const now = "2026-01-01T12:01:00.000Z"
	await invoke(["gate", "fidelity", "not_run", "--reason", "No factual content in this edition", "--now", now])
	const manifest = JSON.parse(readFileSync(join(dir, "outcome.json"), "utf8"))
	expect(manifest.gateHistory).toContainEqual({ gate: "fidelity", status: "not_run", reason: "No factual content in this edition", at: now })
	expect((await invoke(["verify"])).exitCode).toBe(0)
	expect((await invoke(["finish"])).exitCode).toBe(0)
	await invoke(["gate", "fidelity", "pass"])
	expect((await invoke(["verify"])).exitCode).toBe(1)
})

test("#given a missing gate #when skipped without a meaningful reason #then the command refuses", async () => {
	const { invoke } = await delivered()
	for (const reason of [[], ["--reason", "   "]]) {
		await expect(invoke(["gate", "fidelity", "not_run", ...reason])).rejects.toThrow("reason")
	}
})

test("#given a fact ledger and an unverified edition #when the gate is skipped with a reason #then delivery still refuses", async () => {
	const { dir, invoke } = await delivered()
	writeFileSync(join(dir, "fact-ledger.json"), JSON.stringify({ version: 1, facts: [] }))
	await invoke(["gate", "fidelity", "not_run", "--reason", "This harness has no verifier"])
	for (const command of ["verify", "finish"]) {
		const result = await invoke([command])
		expect(result.exitCode).toBe(1)
		expect(JSON.stringify(result.json.problems)).toContain("fidelity gate not run")
	}
})

test("#given a stale fidelity record nobody attached #when the gate is skipped with a reason #then delivery still refuses", async () => {
	const { dir, invoke } = await delivered()
	writeFileSync(join(dir, "fidelity-defects.json"), JSON.stringify({ artifact_sha256: "0".repeat(64), defects: [] }))
	await invoke(["gate", "fidelity", "not_run", "--reason", "This harness has no verifier"])
	for (const command of ["verify", "finish"]) {
		const result = await invoke([command])
		expect(result.exitCode).toBe(1)
		expect(JSON.stringify(result.json.problems)).toContain("fidelity gate not run")
	}
})

test("#given an explicit skip and an existing blocker #when verified #then the skip cannot release the blocker", async () => {
	const { invoke } = await delivered("html", ["claim_status_invalid"])
	await invoke(["gate", "fidelity", "not_run", "--reason", "Unsupported edition"])
	expect((await invoke(["verify"])).exitCode).toBe(1)
})

const LOCKED_BRIEF = readFileSync(join(import.meta.dir, "tests", "fixtures", "fidelity-brief-locked.md"), "utf8")

/** A delivered, fidelity-verified html edition in a session whose locked brief sets `meaning check`. */
async function meaningSession(meaning: "on" | "off", codes: string[] | null) {
	const session = await delivered("html", [])
	writeFileSync(join(session.dir, "brief.md"), LOCKED_BRIEF.replace("meaning check: on", `meaning check: ${meaning}`))
	if (codes !== null) writeFileSync(join(session.dir, MEANING_RECORD), JSON.stringify({ command: "fact meaning-check", defects: codes.map((code) => ({ code, severity: "major", message: code })) }))
	return session
}

test("#given the record table #when read #then it names the fidelity and meaning records, each with a required-when rule", () => {
	expect(FIDELITY_RECORDS.map((entry) => entry.file)).toEqual(["fidelity-defects.json", MEANING_RECORD])
	for (const entry of FIDELITY_RECORDS) expect(typeof entry.requiredWhen).toBe("function")
})

for (const code of ["meaning_drift_confirmed", "meaning_unverified"]) {
	test(`#given a meaning record with ${code} #when verified and finished #then delivery refuses`, async () => {
		const { dir, invoke } = await meaningSession("on", [code])
		for (const command of ["verify", "finish"]) {
			const result = await invoke([command])
			expect(result.exitCode).toBe(1)
			expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "fidelity_unresolved", codes: [code], path: join(dir, MEANING_RECORD) }))
		}
	})
}

test("#given the brief says meaning check on and the meaning step was skipped #when verified and finished #then delivery refuses: meaning gate not run", async () => {
	const { invoke } = await meaningSession("on", null)
	for (const command of ["verify", "finish"]) {
		const result = await invoke([command])
		expect(result.exitCode).toBe(1)
		expect(JSON.stringify(result.json.problems)).toContain("meaning gate not run")
	}
})

test("#given the brief says meaning check off and no meaning record #when verified and finished #then delivery passes", async () => {
	const { invoke } = await meaningSession("off", null)
	expect((await invoke(["verify"])).exitCode).toBe(0)
	expect((await invoke(["finish"])).exitCode).toBe(0)
})

test("#given a clean meaning record (warn only) under meaning check on #when verified #then delivery passes", async () => {
	const { invoke } = await meaningSession("on", ["meaning_drift_warn"])
	expect((await invoke(["verify"])).exitCode).toBe(0)
})

test("#given meaning check on, no fidelity evidence, and an explicit fidelity not_run #when verified #then the logged exemption covers the meaning step too", async () => {
	const { dir, invoke } = await delivered()
	writeFileSync(join(dir, "brief.md"), LOCKED_BRIEF)
	await invoke(["gate", "fidelity", "not_run", "--reason", "No factual content in this edition"])
	expect((await invoke(["verify"])).exitCode).toBe(0)
})
