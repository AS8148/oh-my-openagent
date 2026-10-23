// fact-ledger.mjs - the verbatim fact ledger: one row per measured, quoted, derived, assumed,
// or converted value, with its source locator and exact rational. Rows are never deleted:
// retract and supersede change status and append an event. Validation and the field vocabulary
// live in fact-ledger-schema.mjs and are re-exported here. node: builtins only.

import { existsSync } from "node:fs"
import { join } from "node:path"

import { CliError, readJsonFile, writeJsonAtomic } from "./cli-support.mjs"
import { DECIMAL, LEDGER_SCHEMA_VERSION, ROW_DEFAULTS, ROW_FIELDS, isNonEmpty, isString, validateLedger } from "./fact-ledger-schema.mjs"

export { FACT_KINDS, FACT_STATUSES, LEDGER_SCHEMA_VERSION, OPERATIONS, QUALIFIERS, ROW_FIELDS, validateLedger } from "./fact-ledger-schema.mjs"

export const LEDGER_FILENAME = "fact-ledger.json"

export function emptyLedger() {
	return { schemaVersion: LEDGER_SCHEMA_VERSION, rows: [], events: [] }
}

function assertValid(ledger) {
	const errors = validateLedger(ledger)
	if (errors.length > 0) throw new CliError(`invalid fact ledger: ${errors.join("; ")}`)
}

export function readLedger(dir) {
	const file = join(dir, LEDGER_FILENAME)
	if (!existsSync(file)) return emptyLedger()
	const ledger = readJsonFile(file)
	assertValid(ledger)
	return ledger
}

export function writeLedger(dir, ledger) {
	assertValid(ledger)
	const file = join(dir, LEDGER_FILENAME)
	writeJsonAtomic(file, ledger)
	return file
}

/** F<n> for every value row (measured, derived, assumed, converted); Q<n> for quotes. */
export function nextId(ledger, kind) {
	const prefix = kind === "quote" ? "Q" : "F"
	let max = 0
	for (const row of ledger.rows) {
		const match = new RegExp(`^${prefix}(\\d+)$`).exec(row.fact_id ?? "")
		if (match) max = Math.max(max, Number(match[1]))
	}
	return `${prefix}${max + 1}`
}

/** The exact rational of a decimal string, reduced. */
export function exactFromDecimal(value) {
	const [whole, fraction = ""] = value.replace(/^-/, "").split(".")
	let num = BigInt(whole + fraction)
	let den = 10n ** BigInt(fraction.length)
	let a = num
	let b = den
	while (b !== 0n) [a, b] = [b, a % b]
	if (a > 1n) [num, den] = [num / a, den / a]
	return { num: `${value.startsWith("-") && num !== 0n ? "-" : ""}${num}`, den: `${den}` }
}

/** Fill defaults, assign the next id, validate the whole ledger, then append. */
export function addRow(ledger, row) {
	const filled = { ...structuredClone(ROW_DEFAULTS), ...row, fact_id: row.fact_id ?? nextId(ledger, row.kind) }
	if (filled.kind === "measured" && filled.exact === null && isString(filled.value) && DECIMAL.test(filled.value)) {
		filled.exact = exactFromDecimal(filled.value)
	}
	const ordered = Object.fromEntries(ROW_FIELDS.filter((key) => Object.hasOwn(filled, key)).map((key) => [key, filled[key]]))
	for (const key of Object.keys(filled)) if (!ROW_FIELDS.includes(key)) ordered[key] = filled[key]
	assertValid({ ...ledger, rows: [...ledger.rows, ordered] })
	ledger.rows.push(ordered)
	return ordered
}

function changeStatus(ledger, id, to, replacement, reason) {
	const row = ledger.rows.find((candidate) => candidate.fact_id === id)
	if (!row) throw new CliError(`no ledger row ${id}`)
	if (row.status !== "active") throw new CliError(`ledger row ${id} is already ${row.status}`)
	if (!isNonEmpty(reason)) throw new CliError(`a reason is required to mark ${id} ${to}`)
	const next = replacement === null ? null : ledger.rows.find((candidate) => candidate.fact_id === replacement && candidate.fact_id !== id)
	if (replacement !== null && !next) throw new CliError(`no replacement row ${replacement}`)
	if (next && next.status !== "active") throw new CliError(`replacement row ${replacement} is ${next.status}`)
	ledger.events.push({ fact_id: id, from: row.status, to, replacement, reason })
	row.status = to
	return row
}

export function retractRow(ledger, id, reason) {
	return changeStatus(ledger, id, "retracted", null, reason)
}

export function supersedeRow(ledger, id, replacementId, reason) {
	if (replacementId === null || replacementId === undefined) {
		throw new CliError(`supersede ${id} needs a replacement row; use retract for a fact with no replacement`)
	}
	return changeStatus(ledger, id, "superseded", replacementId, reason)
}

function cell(value) {
	return value === null || value === undefined ? "" : String(value).replace(/\|/g, "\\|").replace(/\n/g, " ")
}

/** The `--view` table: one line per row, retracted and superseded rows included. */
export function renderLedgerMarkdown(ledger) {
	const lines = ["| fact_id | kind | label | value | unit | source | status | raw |", "|---|---|---|---|---|---|---|---|"]
	for (const row of ledger.rows) {
		lines.push(`| ${[row.fact_id, row.kind, row.label, row.value, row.unit, row.source_id, row.status, row.raw].map(cell).join(" | ")} |`)
	}
	return `${lines.join("\n")}\n`
}
