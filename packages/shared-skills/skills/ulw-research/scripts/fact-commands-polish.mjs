// fact-commands-polish.mjs - `fact polish-apply` and `fact polish-diff`, the script half of the
// proofread gate, plus the --changed-since filter of `fact pairs`.
//
// The writing lane returns polish-edits.json ([{before, after, reason}]) and never edits the
// report. polish-apply applies each edit through polish-apply.mjs and writes the result; a
// rejected (major) or unlocated (minor) edit leaves its region unchanged and is listed with its
// index and reason so the orchestrator can re-send it. It exits 0 whenever it wrote the output.
// polish-diff is the whole-document backstop (polish-diff.mjs) between the pre-polish artifact
// and any later copy; it exits 1 on a blocker. pairsChangedSince keeps only the pairs whose
// sentence text (normalized) is not in the pre-polish artifact that a fill map names, so the
// meaning readers re-check exactly what polish rewrote. No model, no network.

import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { CliError, parseArgs, readJsonFile, writeJsonAtomic } from "./cli-support.mjs"
import { countDefects, DEFECT_CODES } from "./contracts.mjs"
import { editionFormatOf, ledgerFrom, markdownAsHtml, sessionOf } from "./fact-commands-verify.mjs"
import { extractPairs } from "./fact-pairs.mjs"
import { applyEdits, POLISH_EDIT_FIELDS, validatePolishEdits } from "./polish-apply.mjs"
import { diffPolish } from "./polish-diff.mjs"
import { normalizeText } from "./text-normalize.mjs"

export { ledgerFrom, POLISH_EDIT_FIELDS, validatePolishEdits }

export const POLISH_RECORD = "polish-defects.json"

/** The polish-diff exit policy: only a registry blocker fails the command; majors are reported. */
export const polishDiffFails = (defects) => defects.some((defect) => (DEFECT_CODES[defect.code]?.severity ?? defect.severity) === "blocker")

const sha256 = (text) => createHash("sha256").update(text).digest("hex")

function readText(path) {
	try {
		return readFileSync(path, "utf8")
	} catch (error) {
		throw new CliError(`cannot read ${path}: ${error.code ?? error.message}`)
	}
}

const withSeverity = (entry) => ({ ...entry, severity: DEFECT_CODES[entry.code].severity, hint: DEFECT_CODES[entry.code].hint })

function runPolishApply(args) {
	const [report] = args.positionals
	const { flags } = args
	if (!report || flags.edits === undefined || flags.out === undefined) throw new CliError("usage: fact polish-apply <report.html> --edits polish-edits.json --out <report.polished.html> [--ledger F] [--session-dir D]")
	if (editionFormatOf(report) === "md") throw new CliError("fact polish-apply takes the filled HTML edition; polish a Markdown edition through its HTML source")
	const html = readText(report)
	const editsText = readText(flags.edits)
	const edits = readJsonFile(flags.edits)
	try {
		validatePolishEdits(edits)
	} catch (error) {
		throw new CliError(`${flags.edits} must be an array of {${Object.keys(POLISH_EDIT_FIELDS).join(", ")}} objects: ${error.message}`)
	}
	const result = applyEdits(html, edits, ledgerFrom(flags))
	writeFileSync(flags.out, result.out)
	const defects = [...result.rejected, ...result.unlocated].sort((a, b) => a.index - b.index).map(withSeverity)
	const counts = { applied: result.applied.length, rejected: result.rejected.length, unlocated: result.unlocated.length }
	const data = { out: resolve(flags.out), ...counts, applied_indexes: result.applied, input_sha256: sha256(html), edits_sha256: sha256(editsText), out_sha256: sha256(result.out) }
	const summary = `fact polish-apply: ${counts.applied} applied, ${counts.rejected} rejected, ${counts.unlocated} unlocated of ${edits.length} edit(s)`
	return { json: { command: "fact polish-apply", status: "pass", exitCode: 0, defects, data }, summary, exitCode: 0 }
}

function runPolishDiff(args) {
	const { flags } = args
	if (flags.before === undefined || flags.after === undefined) throw new CliError("usage: fact polish-diff --before <pre-polish.html> --after <polished.html> [--ledger F] [--out polish-defects.json] [--session-dir D]")
	const after = readText(flags.after)
	const defects = diffPolish(readText(flags.before), after, ledgerFrom(flags)).map((defect) => ({ ...defect, hint: DEFECT_CODES[defect.code]?.hint ?? null }))
	const counts = countDefects(defects)
	const status = polishDiffFails(defects) ? "fail" : "pass"
	const exitCode = status === "fail" ? 1 : 0
	const record = { command: "fact polish-diff", status, exitCode, before: resolve(flags.before), artifact: resolve(flags.after), artifact_sha256: sha256(after), defects, counts }
	const session = sessionOf(flags)
	const out = flags.out ?? (session === null ? null : join(session, POLISH_RECORD))
	if (out !== null) writeJsonAtomic(resolve(out), record)
	const summary = `fact polish-diff: ${status.toUpperCase()} - ${counts.blocker} blocker, ${counts.major} major, ${counts.minor} minor`
	return { json: { ...record, out: out === null ? null : resolve(out) }, summary, exitCode }
}

const pairKey = (pair) => [pair.kind, pair.sentence_key, pair.claim_id ?? "", normalizeText(pair.sentence)].join("\u0000")

/**
 * The pairs whose sentence text changed since the pre-polish artifact a fill map names: a pair is
 * kept unless the same (kind, sentence key, normalized sentence) occurs in that artifact.
 * @param {object[]} pairs extractPairs output on the polished edition
 * @param {string} mapPath the pre-polish fill map (fact fill's `<out>.fill-map.json`)
 */
export function pairsChangedSince(pairs, mapPath, ledger, claims) {
	const map = readJsonFile(mapPath)
	if (typeof map.artifact !== "string" || !existsSync(map.artifact)) throw new CliError(`${mapPath} names no readable pre-polish artifact`)
	const text = readText(map.artifact)
	if (map.artifact_sha256 !== undefined && sha256(text) !== map.artifact_sha256) throw new CliError(`${map.artifact} changed after fill; --changed-since needs the pre-polish bytes`)
	const html = map.format === "md" ? markdownAsHtml(text, map.entries, ledger).html : text
	const before = new Map()
	for (const pair of extractPairs(html, ledger, claims)) before.set(pairKey(pair), (before.get(pairKey(pair)) ?? 0) + 1)
	return pairs.filter((pair) => {
		const left = before.get(pairKey(pair)) ?? 0
		if (left === 0) return true
		before.set(pairKey(pair), left - 1)
		return false
	})
}

/** @param {string[]} argv the arguments after `fact polish-apply` or `fact polish-diff` */
export function runFactPolish(sub, argv) {
	const args = parseArgs(argv)
	return sub === "polish-apply" ? runPolishApply(args) : runPolishDiff(args)
}
