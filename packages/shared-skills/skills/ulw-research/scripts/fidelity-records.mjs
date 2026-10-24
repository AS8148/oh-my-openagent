// fidelity-records.mjs - the delivery barrier of `outcome verify` and `outcome finish`.
//
// FIDELITY_RECORDS is the one table of session fidelity records the barrier reads. Each entry names
// its file, the step that writes it, and when the session must have it. The barrier unions the
// unresolved defects of every record present (registry policy via blocksDelivery, independent of
// the repair budget) and refuses a required record that is missing ("<step> not run"). A new
// fidelity step adds a row here; nothing else in the barrier changes.
//
// HTML/PDF/DOCX need a gate record or an explicitly logged not_run reason, even without a ledger.
// That logged exemption covers deliveries this harness never gated: once a ledger or any fidelity
// record exists for the session, the barrier refuses the unverified edition regardless of it, and
// the same exemption is the only way a required record may be absent. Recorded editions must match
// their source bytes (`edition_unverified`).

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { CliError, readJsonFile } from "./cli-support.mjs"
import { LEDGER_FILENAME } from "./fact-ledger.mjs"
import { meaningCheckEnabled, requireLockedBrief } from "./fidelity-brief.mjs"
import { blocksDelivery, deliveryBlockReason } from "./gates-fidelity.mjs"

export const FIDELITY_RECORD = "fidelity-defects.json"
export const MEANING_RECORD = "fidelity-meaning-defects.json"

/** The meaning record is required unless the locked brief turns the check off; a malformed block cannot prove off. */
function meaningRequired(sessionDir) {
	const lock = requireLockedBrief(join(sessionDir, "brief.md"))
	return lock.exitCode === 2 || (lock.locked && meaningCheckEnabled(lock.parsed))
}

/**
 * The session fidelity records the barrier reads, in check order. requiredWhen(sessionDir) says
 * whether a delivered session must carry the record; the fidelity record is required per edition
 * (through verifiedBy, below), so its session-level rule is never.
 */
export const FIDELITY_RECORDS = Object.freeze([
	Object.freeze({ file: FIDELITY_RECORD, step: "fidelity gate", writer: "fact verify", requiredWhen: () => false }),
	Object.freeze({ file: MEANING_RECORD, step: "meaning gate", writer: "fact pairs and fact meaning-check", requiredWhen: meaningRequired }),
])

const sha256Of = (content) => createHash("sha256").update(content).digest("hex")

function unresolvedIn(record) {
	const defects = Array.isArray(record) ? record : record?.defects
	if (!Array.isArray(defects)) throw new CliError("a fidelity record must be a defect array or an object with a defects array")
	return [...new Set(defects.filter(blocksDelivery).map((defect) => defect?.code))].sort()
}

const unresolved = (format, codes, path) => ({ code: "fidelity_unresolved", format, codes, message: codes.map((code) => deliveryBlockReason({ code })).join("; "), path })

/** Barrier problems for `outcome verify` and `outcome finish`; empty when nothing blocks delivery. */
export function fidelityProblems(sessionDir, manifest) {
	const problems = []
	const records = FIDELITY_RECORDS.map((entry) => ({ ...entry, path: join(sessionDir, entry.file) }))
	for (const record of records) {
		if (!existsSync(record.path)) continue
		const codes = unresolvedIn(readJsonFile(record.path))
		if (codes.length > 0) problems.push(unresolved(null, codes, record.path))
	}
	const sessionRecord = records[0].path
	const hasFidelity = existsSync(join(sessionDir, LEDGER_FILENAME)) || records.some((record) => existsSync(record.path))
	const lastFidelity = manifest.gateHistory?.findLast((entry) => entry.gate === "fidelity")
	const exempt = manifest.gates.fidelity === "not_run" && lastFidelity?.status === "not_run" && lastFidelity.reason?.trim()
	const delivered = manifest.deliverables.filter((row) => row.status === "delivered")
	if (delivered.length > 0 && !(exempt && !hasFidelity)) {
		for (const record of records) {
			if (existsSync(record.path) || !record.requiredWhen(sessionDir)) continue
			problems.push({ code: "edition_unverified", format: null, message: `${record.step} not run; run ${record.writer} before delivery`, path: record.path })
		}
	}
	for (const row of delivered) {
		if (!row.verifiedBy && exempt && !hasFidelity) continue
		if (!hasFidelity && !row.verifiedBy) {
			if (["html", "pdf", "docx"].includes(row.format)) problems.push({ code: "edition_unverified", format: row.format, message: `${row.format}: fidelity gate not run`, path: row.path })
			continue
		}
		if (!row.path) continue
		const subject = row.renderedFrom ?? row.path
		const unverified = (message) => problems.push({ code: "edition_unverified", format: row.format, message: `${row.format}: ${message}`, path: subject })
		if (!row.verifiedBy) {
			unverified(`fidelity gate not run; run fact verify on ${subject} and set it with --verified-by`)
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
