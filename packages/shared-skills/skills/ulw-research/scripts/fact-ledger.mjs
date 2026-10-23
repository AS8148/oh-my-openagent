// fact-ledger.mjs - the verbatim fact ledger: one row per measured, quoted, derived, assumed,
// or converted value, with its source locator and exact rational. Rows are never deleted:
// retract and supersede change status and append an event. node: builtins only.

import { existsSync } from "node:fs"
import { join } from "node:path"

import { CliError, readJsonFile, writeJsonAtomic } from "./cli-support.mjs"

export const LEDGER_FILENAME = "fact-ledger.json"
export const LEDGER_SCHEMA_VERSION = 1
export const FACT_KINDS = Object.freeze(["measured", "quote", "derived", "assumed", "converted"])
export const FACT_STATUSES = Object.freeze(["active", "superseded", "retracted"])
export const OPERATIONS = Object.freeze(["sum", "diff", "growth", "ratio", "share", "convert", "expr"])
/** Canonical qualifier terms; surface forms in either language map onto these. */
export const QUALIFIERS = Object.freeze([
	"upper_inclusive",
	"lower_inclusive",
	"approximate",
	"near",
	"lower_exclusive",
	"upper_exclusive",
])

const DEFAULTS = Object.freeze({
	value: null,
	unit: null,
	value_span: null,
	source_id: null,
	locator: null,
	locate_hint: null,
	snapshot_sha256: null,
	valid_at: null,
	qualifier: null,
	entity: null,
	sentence_id: null,
	observation_id: null,
	fuzzy: false,
	outside_floor: false,
	population: null,
	missing_rule: null,
	accounting_basis: null,
	snapshot_window: null,
	revision: null,
	exact: null,
	render: null,
	operation: null,
	operands: [],
	derived_from: [],
	formula: null,
	factor: null,
	rationale: null,
	status: "active",
})
const REQUIRED = ["fact_id", "kind", "raw", "quote", "extracted_by", "observed_at", "label"]
export const ROW_FIELDS = Object.freeze([...REQUIRED, ...Object.keys(DEFAULTS)])
const SOURCED_KINDS = new Set(["measured", "quote"])

const DECIMAL = /^-?\d+(?:\.\d+)?$/
const INTEGER = /^-?\d+$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const LABEL = /^[a-z0-9_-]{1,32}$/
const FACT_REF = /^[FQ]\d+$/
const SHA256 = /^[0-9a-f]{64}$/

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function check(errors, condition, message) {
	if (!condition) errors.push(message)
}

function nullOr(value, test) {
	return value === null || test(value)
}

const isString = (value) => typeof value === "string"
const isNonEmpty = (value) => typeof value === "string" && value.length > 0
const isCount = (value) => Number.isInteger(value) && value >= 0

function validateLocator(locator, at, errors) {
	if (!isObject(locator)) return errors.push(`${at}.locator must be an object`)
	check(errors, isNonEmpty(locator.artifact), `${at}.locator.artifact must be a non-empty string`)
	check(errors, isCount(locator.char_start) && isCount(locator.char_end) && locator.char_start <= locator.char_end, `${at}.locator.char_start/char_end must be integers with start <= end`)
	for (const key of ["page", "line"]) {
		if (locator[key] !== undefined) check(errors, Number.isInteger(locator[key]) && locator[key] >= 1, `${at}.locator.${key} must be an integer >= 1`)
	}
	for (const key of ["table", "row_label", "col_label"]) {
		if (locator[key] !== undefined) check(errors, isString(locator[key]), `${at}.locator.${key} must be a string`)
	}
}

function validateExact(exact, at, errors) {
	if (exact === null) return
	const ok = isObject(exact) && isString(exact.num) && isString(exact.den) && INTEGER.test(exact.num) && /^\d+$/.test(exact.den) && !/^0+$/.test(exact.den)
	check(errors, ok, `${at}.exact must be null or { num: integer string, den: positive integer string }`)
}

function validateRow(row, index, errors) {
	const at = `rows[${index}]`
	if (!isObject(row)) return errors.push(`${at} must be an object`)
	for (const key of ROW_FIELDS) check(errors, Object.hasOwn(row, key), `${at}.${key} is required`)
	for (const key of Object.keys(row)) check(errors, ROW_FIELDS.includes(key), `${at}.${key} is not a ledger field`)
	const kind = row.kind
	check(errors, FACT_KINDS.includes(kind), `${at}.kind must be one of ${FACT_KINDS.join(", ")}`)
	const idPattern = kind === "quote" ? /^Q\d+$/ : /^F\d+$/
	check(errors, isString(row.fact_id) && idPattern.test(row.fact_id), `${at}.fact_id must match ${kind === "quote" ? "Q<n>" : "F<n>"}`)
	if (kind === "quote") check(errors, row.value === null || row.value === undefined, `${at}.value must be null for a quote row`)
	else if (FACT_KINDS.includes(kind)) check(errors, isString(row.value) && DECIMAL.test(row.value), `${at}.value must be a decimal string`)
	check(errors, row.unit === undefined || nullOr(row.unit, isNonEmpty), `${at}.unit must be null or a non-empty token`)
	for (const key of ["raw", "quote"]) check(errors, row[key] === undefined || isString(row[key]), `${at}.${key} must be a string`)
	check(errors, row.extracted_by === undefined || isNonEmpty(row.extracted_by), `${at}.extracted_by must be a non-empty string`)
	check(errors, row.observed_at === undefined || (isString(row.observed_at) && ISO_DATE.test(row.observed_at)), `${at}.observed_at must be an ISO timestamp`)
	check(errors, row.label === undefined || (isString(row.label) && LABEL.test(row.label)), `${at}.label must match [a-z0-9_-]{1,32}`)
	const span = row.value_span
	check(errors, span === undefined || nullOr(span, (v) => Array.isArray(v) && v.length === 2 && v.every(isCount) && v[0] <= v[1]), `${at}.value_span must be null or [start, end]`)
	const sourced = SOURCED_KINDS.has(kind)
	if (row.source_id !== undefined) check(errors, sourced ? isString(row.source_id) && /^S\d+$/.test(row.source_id) : nullOr(row.source_id, (v) => isString(v) && /^S\d+$/.test(v)), `${at}.source_id must be S<n>${sourced ? "" : " or null"}`)
	if (row.snapshot_sha256 !== undefined) check(errors, sourced ? isString(row.snapshot_sha256) && SHA256.test(row.snapshot_sha256) : nullOr(row.snapshot_sha256, (v) => isString(v) && SHA256.test(v)), `${at}.snapshot_sha256 must be a sha256 hex digest${sourced ? "" : " or null"}`)
	if (row.locator !== undefined && (sourced || row.locator !== null)) validateLocator(row.locator, at, errors)
	for (const key of ["locate_hint", "valid_at", "entity", "observation_id", "missing_rule", "accounting_basis", "formula", "render"]) {
		if (row[key] !== undefined) check(errors, nullOr(row[key], isString), `${at}.${key} must be null or a string`)
	}
	for (const key of ["population", "snapshot_window", "revision"]) {
		if (row[key] !== undefined) check(errors, nullOr(row[key], (v) => isString(v) || isObject(v)), `${at}.${key} must be null, a string, or an object`)
	}
	if (row.qualifier !== undefined) check(errors, nullOr(row.qualifier, (v) => QUALIFIERS.includes(v)), `${at}.qualifier must be null or one of ${QUALIFIERS.join(", ")}`)
	if (row.sentence_id !== undefined) check(errors, nullOr(row.sentence_id, (v) => isString(v) && /^S\d+:s\d+$/.test(v)), `${at}.sentence_id must be null or S<n>:s<k>`)
	for (const key of ["fuzzy", "outside_floor"]) {
		if (row[key] !== undefined) check(errors, typeof row[key] === "boolean", `${at}.${key} must be a boolean`)
	}
	if (row.exact !== undefined) validateExact(row.exact, at, errors)
	if (row.operation !== undefined) check(errors, nullOr(row.operation, (v) => OPERATIONS.includes(v)), `${at}.operation must be null or one of ${OPERATIONS.join(", ")}`)
	for (const key of ["operands", "derived_from"]) {
		if (row[key] !== undefined) check(errors, Array.isArray(row[key]) && row[key].every((v) => isString(v) && FACT_REF.test(v)), `${at}.${key} must be an array of fact ids`)
	}
	if (row.factor !== undefined) check(errors, nullOr(row.factor, (v) => isString(v) && DECIMAL.test(v)), `${at}.factor must be null or a decimal string`)
	if (row.rationale !== undefined) check(errors, nullOr(row.rationale, isString), `${at}.rationale must be null or a string`)
	if (kind === "assumed") check(errors, isNonEmpty(row.rationale), `${at}.rationale is required when kind is assumed`)
	check(errors, row.status === undefined || FACT_STATUSES.includes(row.status), `${at}.status must be one of ${FACT_STATUSES.join(", ")}`)
}

function validateEvent(event, index, ids, errors) {
	const at = `events[${index}]`
	if (!isObject(event)) return errors.push(`${at} must be an object`)
	check(errors, ids.has(event.fact_id), `${at}.fact_id must name a ledger row`)
	check(errors, event.to === "retracted" || event.to === "superseded", `${at}.to must be retracted or superseded`)
	check(errors, event.replacement === null || ids.has(event.replacement), `${at}.replacement must be null or a ledger row`)
	check(errors, isNonEmpty(event.reason), `${at}.reason must be a non-empty string`)
}

/** @returns {string[]} every schema error; empty when the ledger is valid. */
export function validateLedger(ledger) {
	const errors = []
	if (!isObject(ledger)) return ["ledger must be an object"]
	check(errors, ledger.schemaVersion === LEDGER_SCHEMA_VERSION, `schemaVersion must be ${LEDGER_SCHEMA_VERSION}`)
	if (!Array.isArray(ledger.rows)) return [...errors, "rows must be an array"]
	ledger.rows.forEach((row, index) => validateRow(row, index, errors))
	const ids = new Set()
	const labels = new Set()
	ledger.rows.forEach((row, index) => {
		if (!isObject(row)) return
		check(errors, !ids.has(row.fact_id), `rows[${index}].fact_id ${row.fact_id} is a duplicate`)
		check(errors, row.label === undefined || !labels.has(row.label), `rows[${index}] has duplicate label ${row.label}`)
		ids.add(row.fact_id)
		labels.add(row.label)
	})
	if (Array.isArray(ledger.events)) ledger.events.forEach((event, index) => validateEvent(event, index, ids, errors))
	else errors.push("events must be an array")
	return errors
}

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
	const filled = { ...structuredClone(DEFAULTS), ...row, fact_id: row.fact_id ?? nextId(ledger, row.kind) }
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
	if (replacement !== null && !ledger.rows.some((candidate) => candidate.fact_id === replacement && candidate.fact_id !== id)) {
		throw new CliError(`no replacement row ${replacement}`)
	}
	ledger.events.push({ fact_id: id, from: row.status, to, replacement, reason })
	row.status = to
	return row
}

export function retractRow(ledger, id, reason) {
	return changeStatus(ledger, id, "retracted", null, reason)
}

export function supersedeRow(ledger, id, replacementId, reason) {
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
