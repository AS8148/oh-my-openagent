// fact-commands-verify.mjs - `fact verify` and the fidelity delivery barrier of `outcome verify`.
//
// fact verify runs the deterministic fidelity gate over one filled HTML edition and writes a
// record (default $SESSION_DIR/fidelity-defects.json) carrying the artifact's sha256. It exits 1
// on any blocker or major defect (the orchestrator then records `outcome gate fidelity fail`);
// minors alone exit 0 and are listed. Markdown and LaTeX verification arrive with the md-lite
// stage; this stage verifies HTML only.
//
// fidelityProblems is the barrier: an unresolved fidelity code in the session record (or in a
// delivered edition's own record) is `fidelity_unresolved`, independent of the repair budget, and
// in a session with a fact ledger every delivered row needs a verify record whose artifact_sha256
// equals its source's bytes (`edition_unverified`). node: builtins and sibling imports only.

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import { CliError, readJsonFile, writeJsonAtomic } from "./cli-support.mjs"
import { recompute } from "./fact-derive.mjs"
import { LEDGER_FILENAME, readLedger } from "./fact-ledger.mjs"
import { checkFidelity } from "./gates-fidelity.mjs"
import { sessionDirOf } from "./source-commands.mjs"

export const FIDELITY_RECORD = "fidelity-defects.json"
/** Codes that never reach a delivered report, whatever the repair loop decided. */
export const UNRESOLVED_CODES = Object.freeze(["untraceable_number", "value_mismatch", "unit_mismatch", "quote_not_verbatim", "quote_unbound", "unbound_sentence", "chart_value_untraceable"])

const sha256Of = (content) => createHash("sha256").update(content).digest("hex")

function readText(path) {
	try {
		return readFileSync(path, "utf8")
	} catch (error) {
		throw new CliError(`cannot read ${path}: ${error.code ?? error.message}`)
	}
}

/** @param {{ positionals: string[], flags: Record<string, any> }} args parsed by runFact */
export function runFactVerify(args) {
	const [report] = args.positionals
	const { flags } = args
	if (!report) throw new CliError("usage: fact verify <report> [--format html] [--sources D] [--claims claims.json] [--fill-map F] [--brief brief.md] [--out fidelity-defects.json]")
	const format = flags.format ?? "html"
	if (format !== "html") throw new CliError(`fact verify --format ${format}: this stage verifies HTML only; md and tex verification arrive with the md-lite stage`)
	const sessionDir = sessionDirOf(flags)
	const claimsPath = flags.claims ?? join(sessionDir, "claims.json")
	const briefPath = flags.brief ?? join(sessionDir, "brief.md")
	const html = readText(report)
	const result = checkFidelity(html, {
		ledger: readLedger(sessionDir),
		sourcesDir: resolve(flags.sources ?? join(sessionDir, "sources")),
		claims: flags.claims !== undefined || existsSync(claimsPath) ? readJsonFile(claimsPath) : null,
		fillMap: flags["fill-map"] === undefined ? null : readJsonFile(flags["fill-map"]).entries,
		brief: existsSync(briefPath) ? readText(briefPath) : "",
		baseDir: dirname(resolve(report)),
		recompute,
	})
	const counts = { blocker: 0, major: 0, minor: 0, total: result.defects.length }
	for (const defect of result.defects) counts[defect.severity] += 1
	const status = counts.blocker + counts.major > 0 ? "fail" : "pass"
	const exitCode = status === "fail" ? 1 : 0
	const record = { command: "fact verify", status, exitCode, artifact: resolve(report), artifact_sha256: sha256Of(html), defects: result.defects, counts, gatesRun: result.gatesRun }
	const out = resolve(flags.out ?? join(sessionDir, FIDELITY_RECORD))
	writeJsonAtomic(out, record)
	return { json: { ...record, out }, summary: `fact verify: ${status.toUpperCase()} - ${counts.blocker} blocker, ${counts.major} major, ${counts.minor} minor`, exitCode }
}

function unresolvedIn(record) {
	const defects = Array.isArray(record) ? record : record?.defects
	if (!Array.isArray(defects)) throw new CliError("a fidelity record must be a defect array or an object with a defects array")
	return [...new Set(defects.map((defect) => defect.code).filter((code) => UNRESOLVED_CODES.includes(code)))].sort()
}

const unresolved = (format, codes, path) => ({ code: "fidelity_unresolved", format, codes, message: `fidelity_unresolved: ${codes.join(", ")}`, path })

/** Barrier problems for `outcome verify` and `outcome finish`; empty when nothing blocks delivery. */
export function fidelityProblems(sessionDir, manifest) {
	const problems = []
	const sessionRecord = join(sessionDir, FIDELITY_RECORD)
	if (existsSync(sessionRecord)) {
		const codes = unresolvedIn(readJsonFile(sessionRecord))
		if (codes.length > 0) problems.push(unresolved(null, codes, sessionRecord))
	}
	if (!existsSync(join(sessionDir, LEDGER_FILENAME)) && !existsSync(sessionRecord)) return problems
	for (const row of manifest.deliverables) {
		if (row.status !== "delivered" || !row.path) continue
		const subject = row.renderedFrom ?? row.path
		const unverified = (message) => problems.push({ code: "edition_unverified", format: row.format, message: `${row.format}: ${message}`, path: subject })
		if (!row.verifiedBy) {
			unverified(`no verify record; run fact verify on ${subject} and set it with --verified-by`)
			continue
		}
		if (!existsSync(row.verifiedBy)) {
			unverified(`verify record ${row.verifiedBy} is missing`)
			continue
		}
		const record = readJsonFile(row.verifiedBy)
		const actual = existsSync(subject) ? sha256Of(readFileSync(subject)) : null
		if (record.artifact_sha256 !== actual) unverified(`verify record ${row.verifiedBy} is for other bytes than ${subject}`)
		const codes = resolve(row.verifiedBy) === sessionRecord ? [] : unresolvedIn(record)
		if (codes.length > 0) problems.push(unresolved(row.format, codes, row.verifiedBy))
	}
	return problems
}
