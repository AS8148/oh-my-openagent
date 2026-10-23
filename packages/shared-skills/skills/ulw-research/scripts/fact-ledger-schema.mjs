// fact-ledger-schema.mjs - the fact ledger's vocabulary and validation: row fields and defaults,
// kinds, statuses, qualifiers, and validateLedger over rows, status events, and their history.
// Pure functions with no IO; fact-ledger.mjs owns reading, writing, and row changes. node: builtins only.

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

export const ROW_DEFAULTS = Object.freeze({
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
export const ROW_FIELDS = Object.freeze([...REQUIRED, ...Object.keys(ROW_DEFAULTS)])
const SOURCED_KINDS = new Set(["measured", "quote"])

export const DECIMAL = /^-?\d+(?:\.\d+)?$/
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

export const isString = (value) => typeof value === "string"
export const isNonEmpty = (value) => typeof value === "string" && value.length > 0
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
	check(errors, FACT_STATUSES.includes(event.from), `${at}.from must be one of ${FACT_STATUSES.join(", ")} (fact ${event.fact_id})`)
	check(errors, event.to === "retracted" || event.to === "superseded", `${at}.to must be retracted or superseded (fact ${event.fact_id})`)
	check(errors, event.replacement === null || ids.has(event.replacement), `${at}.replacement must be null or a ledger row`)
	check(errors, event.to !== "retracted" || event.replacement === null, `${at}: ${event.fact_id} is retracted but names replacement ${event.replacement}`)
	check(errors, isNonEmpty(event.reason), `${at}.reason must be a non-empty string`)
}

/** Each row's status must be the one its last event moved it to; a non-active row needs an event. */
function validateHistory(ledger, errors) {
	const last = new Map()
	for (const event of ledger.events) if (isObject(event)) last.set(event.fact_id, event.to)
	ledger.rows.forEach((row, index) => {
		if (!isObject(row) || !FACT_STATUSES.includes(row.status)) return
		const to = last.get(row.fact_id)
		if (to === undefined) check(errors, row.status === "active", `rows[${index}]: ${row.fact_id} is ${row.status} but has no status event`)
		else check(errors, to === row.status, `rows[${index}]: ${row.fact_id} has status ${row.status} but its last event moves it to ${to}`)
	})
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
	ledger.rows.forEach((row, index) => {
		for (const key of ["operands", "derived_from"]) {
			if (isObject(row) && Array.isArray(row[key])) for (const ref of row[key]) check(errors, ids.has(ref), `rows[${index}].${key} references ${ref}, which has no ledger row`)
		}
	})
	if (Array.isArray(ledger.events)) {
		ledger.events.forEach((event, index) => validateEvent(event, index, ids, errors))
		validateHistory(ledger, errors)
	} else errors.push("events must be an array")
	return errors
}
