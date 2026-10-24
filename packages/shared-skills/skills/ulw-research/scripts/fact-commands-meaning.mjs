// fact-commands-meaning.mjs - `fact pairs` and `fact meaning-check`, the script half of the
// separate-session meaning verifier. fact pairs writes the (source, report sentence) pairs a
// reader lane gets and nothing else (with --changed-since, only the pairs whose sentence polish
// rewrote); it honours the brief's `meaning check` field and writes
// `{ skipped: true }` when it is off. fact meaning-check ingests the readers' verdict files
// (meaning-check.mjs), writes fidelity-meaning-defects.json, and appends one calibration line per
// flagged pair to fidelity-calibration.jsonl (header with the promotion criterion on first write;
// the same run id never appends twice). Neither command calls a model or the network.

import { createHash } from "node:crypto"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import { CliError, parseArgs, readJsonFile, writeJsonAtomic } from "./cli-support.mjs"
import { countDefects } from "./contracts.mjs"
import { markdownAsHtml, readEdition } from "./fact-commands-verify.mjs"
import { readLedger } from "./fact-ledger.mjs"
import { validateLedger } from "./fact-ledger-schema.mjs"
import { pairsChangedSince } from "./fact-commands-polish.mjs"
import { extractPairs, PAIR_KINDS } from "./fact-pairs.mjs"
import { meaningCheckEnabled, requireLockedBrief } from "./fidelity-brief.mjs"
import { blocksDelivery } from "./gates-fidelity.mjs"
import { ingestVerdicts, unverifiedDefects, VERDICT_SCHEMA } from "./meaning-check.mjs"

export const PAIRS_FILE = "pairs.json"
export const MEANING_RECORD = "fidelity-meaning-defects.json"
export const CALIBRATION_FILE = "fidelity-calibration.jsonl"
/** Starting values, recorded in the calibration log header; changed only with evidence. */
export const PROMOTION = Object.freeze({ code: "meaning_drift_confirmed", to: "integrity", min_runs: 20, max_disputed_to_confirmed: 0.1, false_block_window: 20, max_report_false_blocks_in_window: 2 })

/** The command status: fail when any defect blocks delivery under the registry policy. */
export const meaningStatus = (defects) => (defects.some(blocksDelivery) ? "fail" : "pass")

const sha256 = (text) => createHash("sha256").update(text).digest("hex")
const sessionOf = (flags) => {
	const dir = flags["session-dir"] ?? process.env.SESSION_DIR
	return dir && dir !== true ? resolve(dir) : null
}
const inSession = (session, name, flag) => {
	if (session === null) throw new CliError(`${flag} is required without --session-dir (or SESSION_DIR)`)
	return join(session, name)
}

function readLedgerFrom(flags, session) {
	if (flags.ledger === undefined) {
		if (session === null) throw new CliError("--ledger is required without --session-dir (or SESSION_DIR)")
		return readLedger(session)
	}
	const ledger = readJsonFile(flags.ledger)
	const errors = validateLedger(ledger)
	if (errors.length > 0) throw new CliError(`${flags.ledger} is not a valid fact ledger: ${errors[0]}`)
	return ledger
}

function briefState(flags, session) {
	const path = flags.brief ?? inSession(session, "brief.md", "--brief")
	const lock = requireLockedBrief(path)
	if (lock.exitCode === 2) throw new CliError(`${path}: malformed ## Fidelity block: ${lock.errors.join("; ")}`)
	return { path, locked: lock.locked, off: !meaningCheckEnabled(lock.parsed) }
}

function runPairs(args) {
	const [report] = args.positionals
	const { flags } = args
	if (!report) throw new CliError("usage: fact pairs <report> [--format html|md] [--ledger F] [--claims claims.json] [--changed-since <fill-map.json>] [--brief brief.md] [--out pairs.json]")
	const session = sessionOf(flags)
	const out = resolve(flags.out ?? inSession(session, PAIRS_FILE, "--out"))
	const brief = briefState(flags, session)
	if (!brief.locked) {
		const json = { command: "fact pairs", status: "fail", exitCode: 1, error: "fidelity_interview_incomplete", message: `${brief.path} has no locked ## Fidelity block` }
		return { json, summary: `fact pairs: ${json.message}`, exitCode: 1 }
	}
	if (brief.off) {
		const record = { schemaVersion: 1, skipped: true, reason: "meaning check: off", pairs: [] }
		writeJsonAtomic(out, record)
		return { json: { command: "fact pairs", status: "skipped", exitCode: 0, data: { out, ...record } }, summary: "fact pairs: skipped (meaning check: off)", exitCode: 0 }
	}
	const edition = readEdition(report, flags)
	const claimsPath = flags.claims ?? (session === null ? null : join(session, "claims.json"))
	const claims = claimsPath !== null && (flags.claims !== undefined || existsSync(claimsPath)) ? readJsonFile(claimsPath) : null
	const ledger = readLedgerFrom(flags, session)
	const html = edition.format === "md" ? markdownAsHtml(edition.text, edition.entries, ledger).html : edition.text
	const all = extractPairs(html, ledger, claims)
	const pairs = flags["changed-since"] === undefined ? all : pairsChangedSince(all, flags["changed-since"], ledger, claims)
	const counts = { total: pairs.length, force_strong: pairs.filter((pair) => pair.force_strong).length }
	for (const kind of PAIR_KINDS) counts[kind] = pairs.filter((pair) => pair.kind === kind).length
	const record = { schemaVersion: 1, skipped: false, report: resolve(report), format: edition.format, artifact_sha256: sha256(edition.text), pairs_sha256: sha256(JSON.stringify(pairs)), counts, verdict_schema: VERDICT_SCHEMA, pairs }
	writeJsonAtomic(out, record)
	const summary = `fact pairs: ${counts.total} pair(s), ${counts.force_strong} routed to the strong reader`
	return { json: { command: "fact pairs", status: "pass", exitCode: 0, data: { out, ...record, pairs: undefined } }, summary, exitCode: 0 }
}

function calibrationRows(path) {
	if (!existsSync(path)) return []
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line))
		.filter((row) => row.header !== true)
}

/** The promotion criterion evaluated over the log: runs, disputed-to-confirmed, report-level false blocks. */
export function promotionEligibility(rows) {
	const runs = [...new Set(rows.map((row) => row.run_id))]
	const confirmed = rows.filter((row) => row.confirmed)
	const disputed = confirmed.filter((row) => row.disputed).length
	const ratio = confirmed.length === 0 ? null : disputed / confirmed.length
	const falseBlocks = runs.slice(-PROMOTION.false_block_window).filter((run) => {
		const blocking = confirmed.filter((row) => row.run_id === run)
		return blocking.length > 0 && blocking.every((row) => row.disputed)
	}).length
	const eligible = runs.length >= PROMOTION.min_runs && ratio !== null && ratio < PROMOTION.max_disputed_to_confirmed && falseBlocks <= PROMOTION.max_report_false_blocks_in_window
	return { runs: runs.length, confirmed: confirmed.length, disputed_confirmed: disputed, disputed_to_confirmed: ratio, report_false_blocks_in_window: falseBlocks, eligible }
}

function appendCalibration(path, lines, runId, pairsSha) {
	const before = calibrationRows(path)
	if (before.some((row) => row.run_id === runId)) return { appended: 0, rows: before }
	if (!existsSync(path)) writeFileSync(path, `${JSON.stringify({ header: true, schemaVersion: 1, promotion: PROMOTION, note: "starting values; change them only with evidence" })}\n`)
	const rows = lines.map((line) => ({ ...JSON.parse(line), run_id: runId, pairs_sha256: pairsSha }))
	if (rows.length > 0) appendFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)
	return { appended: rows.length, rows: [...before, ...rows] }
}

function runMeaningCheck(args) {
	const { flags } = args
	const usage = "usage: fact meaning-check --pairs pairs.json --verdicts cheap.json [--verdicts strong.json] [--dispute P<n> --reason TEXT] [--run-id ID] [--calibration F] [--out F]"
	if (flags.pairs === undefined || !Array.isArray(flags.verdicts)) throw new CliError(usage)
	const session = sessionOf(flags)
	const pairsText = readFileSync(flags.pairs, "utf8")
	const pairsDoc = readJsonFile(flags.pairs)
	if (pairsDoc?.skipped === true) return { json: { command: "fact meaning-check", status: "skipped", exitCode: 0, defects: [] }, summary: JSON.stringify({ command: "fact meaning-check", status: "skipped" }), exitCode: 0 }
	for (const file of flags.verdicts) readJsonFile(file)
	const verdictTexts = flags.verdicts.map((file) => readFileSync(file, "utf8"))
	const dispute = flags.dispute === undefined ? undefined : { pair_id: flags.dispute, reason: args.required("reason") }
	let result
	try {
		result = ingestVerdicts(pairsDoc, flags.verdicts, dispute ? { dispute } : {})
	} catch (error) {
		throw new CliError(`invalid verdict input: ${error.message}`)
	}
	const out = resolve(flags.out ?? inSession(session, MEANING_RECORD, "--out"))
	const calibration = resolve(flags.calibration ?? join(session ?? dirname(out), CALIBRATION_FILE))
	const runId = flags["run-id"] ?? sha256([pairsText, ...verdictTexts, JSON.stringify(dispute ?? null)].join("\0")).slice(0, 16)
	const pairsSha = pairsDoc.pairs_sha256 ?? sha256(pairsText)
	const log = appendCalibration(calibration, result.calibrationLines, runId, pairsSha)
	const defects = [...result.defects, ...unverifiedDefects(result.unverified)]
	const counts = countDefects(defects)
	const status = meaningStatus(defects)
	const exitCode = status === "fail" ? 1 : 0
	const record = { command: "fact meaning-check", status, exitCode, run_id: runId, pairs_sha256: pairsSha, defects, counts, dropped: result.dropped, unverified: result.unverified, calibration_path: calibration, calibration_appended: log.appended, promotion_eligibility: promotionEligibility(log.rows) }
	writeJsonAtomic(out, record)
	const confirmed = result.defects.filter((defect) => defect.code === "meaning_drift_confirmed").length
	const summary = JSON.stringify({ command: "fact meaning-check", status, defects: defects.length, confirmed, warn: result.defects.length - confirmed, dropped: result.dropped.length, unverified: result.unverified.length })
	return { json: { ...record, out }, summary, exitCode }
}

/** @param {string[]} argv the arguments after `fact pairs` or `fact meaning-check` */
export function runFactMeaning(sub, argv) {
	const args = parseArgs(argv, { repeatable: ["verdicts"] })
	return sub === "pairs" ? runPairs(args) : runMeaningCheck(args)
}
