// fact-derive.mjs - script-computed derivations and conversions over the fact ledger.
// derive() asks the operation registry (unit-rules.mjs) for the operand guards and the result unit, computes in exact
// rationals from each operand's `exact` (never its rounded `value`), and appends a derived or converted row whose
// declared unit must equal the registry's canonical unit and whose context fields (sum: disjoint, reference; convert:
// target) are persisted for recompute. Sums, differences, an expr whose root is + or -, and every %p result render at
// the operands' (and literals') fewest decimal places, half away from zero (1000 - 3 is 997, 9 - 1.5 is 8, 19.0 - 1.5
// is 17.5, 1.25 + 2.5 is 3.8); everything else at their fewest significant figures (renderPrecision, unit-rules.mjs). recompute() repeats the arithmetic so the
// verifier compares exact, value, and render with no epsilon (fact-recompute.mjs). Every failure is incompatible_operands;
// no row is written.

import { evaluate, leaves, parseExpr } from "./fact-expr.mjs"
import { addRow, nextId } from "./fact-ledger.mjs"
import { add, div, fromDecimal, mul, sigFigsOf, sub, toDecimal } from "./rational.mjs"
import { inputScale, RuleError } from "./unit-algebra.mjs"
import { canonicalUnit, expectedUnit, inferExpr, operandUnit, renderPrecision, ruleOf, unitMismatch } from "./unit-rules.mjs"
import { convertFactor, normalizeUnit } from "./units.mjs"

export { recompute } from "./fact-recompute.mjs"

const INCOMPATIBLE = "incompatible_operands"
const HUNDRED = fromDecimal("100")

const refuse = (detail) => {
	throw new RuleError(detail)
}
const toBig = (exact) => ({ num: BigInt(exact.num), den: BigInt(exact.den) })
const toText = (r) => ({ num: r.num.toString(), den: r.den.toString() })
const placesOf = (decimal) => (String(decimal).split(".")[1] ?? "").length

function terminates(r) {
	let den = r.den
	for (const prime of [2n, 5n]) while (den % prime === 0n) den /= prime
	return den === 1n
}

function toPlaces(r, places) {
	const digits = ((r.num < 0n ? -r.num : r.num) * 10n ** BigInt(places) * 2n + r.den) / (r.den * 2n)
	const text = digits.toString().padStart(places + 1, "0")
	return (r.num < 0n && digits !== 0n ? "-" : "") + (places ? `${text.slice(0, -places)}.${text.slice(-places)}` : text)
}

/** The header's precision rule, but never trailing zeros the exact result does not have: 20 - 15 is 5, not 5.0. */
function renderValue(exact, precision, byPlaces) {
	const plain = terminates(exact) ? toDecimal(exact) : null
	if (plain !== null && (byPlaces ? placesOf(plain) <= precision : sigFigsOf(plain) < precision)) return plain
	return byPlaces ? toPlaces(exact, precision) : toDecimal(exact, precision)
}

export function display(value, unit) {
	const [whole, fraction] = value.split(".")
	const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction === undefined ? "" : `.${fraction}`)
	if (unit === null || unit === undefined) return grouped
	return unit === "%" || normalizeUnit(unit) === "%" ? `${grouped}%` : `${grouped} ${unit}`
}

function lookup(ledger, id, requireActive) {
	const row = ledger.rows.find((candidate) => candidate.fact_id === id)
	if (!row) refuse(`no ledger row ${id}`)
	if (requireActive && row.status !== "active") refuse(`${id} is ${row.status}`)
	if (row.exact === null || row.value === null) refuse(`${id} has no exact value to derive from`)
	return row
}

const nonZero = (r, what) => (r.num === 0n ? refuse(`${what} is zero`) : r)

function convertOf(row, target) {
	const factor = convertFactor(operandUnit(row), target)
	const scale = { num: factor.num, den: factor.den }
	const exact = add(mul(toBig(row.exact), scale), factor.offset ?? 0n)
	const factorText = terminates(scale) ? toDecimal(scale) : `${scale.num}/${scale.den}`
	const offset = factor.offset ? ` + ${factor.offset.num}/${factor.offset.den}` : ""
	return { exact, factor: terminates(scale) ? factorText : null, formula: `${row.fact_id} * ${factorText}${offset}` }
}

/** Arithmetic only, fixed per operation: `unit` is the registry's result unit and never picks the arithmetic. */
function compute(op, rows, unit, ast, context) {
	const values = rows.map((row) => toBig(row.exact))
	const ids = rows.map((row) => row.fact_id)
	const [a, b] = values
	const literals = ast ? leaves(ast).literals : []
	const sigFigs = Math.min(...rows.map((row) => sigFigsOf(row.value)), ...literals.map((literal) => sigFigsOf(literal)))
	const places = Math.min(...rows.map((row) => placesOf(row.value)), ...literals.map(placesOf))
	let out
	if (op === "sum") out = { exact: values.reduce((total, value) => add(total, value)), formula: ids.join(" + ") }
	else if (op === "diff") out = { exact: sub(a, b), formula: `${ids[0]} - ${ids[1]}` }
	else if (op === "growth") out = { exact: mul(div(sub(b, a), nonZero(a, ids[0])), HUNDRED), formula: `(${ids[1]} - ${ids[0]}) / ${ids[0]} * 100` }
	else if (op === "share") out = { exact: mul(div(a, nonZero(b, ids[1])), HUNDRED), formula: `${ids[0]} / ${ids[1]} * 100` }
	else if (op === "ratio") out = { exact: div(a, nonZero(b, ids[1])), formula: `${ids[0]} / ${ids[1]}` }
	else if (op === "convert") out = convertOf(rows[0], context.target)
	else {
		const { units } = inferExpr(ast, new Map(rows.map((row) => [row.fact_id, operandUnit(row)])))
		out = { exact: evaluate(ast, new Map(ids.map((id, index) => [id, values[index]])), units), formula: null }
	}
	const byPlaces = renderPrecision(op, unit, ast) === "places"
	const value = renderValue(out.exact, byPlaces ? places : sigFigs, byPlaces)
	const shown = display(value, unit)
	const render = op === "convert" ? `${shown} (${display(rows[0].value, rows[0].unit)})` : shown
	return { exact: toText(out.exact), value, render, formula: out.formula, factor: out.factor ?? null }
}

/** The unit a spec declares, canonicalized at input; omission is an error, not null. */
function declaredUnit(spec) {
	const own = Object.hasOwn(spec, "unit")
	if (!own && spec.op !== "convert") refuse("declare the result unit: pass unit (null for a dimensionless result)")
	const declared = own ? spec.unit : spec.to
	if (inputScale(declared)) refuse(`${declared} needs rescaling: declare %p and scale the value`)
	return canonicalUnit(declared ?? null)
}

function operandIds(spec, ast) {
	const ids = ruleOf(spec.op).operandIds(spec, ast)
	if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) refuse(`${spec.op} needs its operand fact ids`)
	return ids
}

/**
 * @returns {{row: object, compatibility: "checked" | "unchecked"} | {error: "incompatible_operands", detail: string, hint?: string}}
 */
export function derive(ledger, spec) {
	try {
		const rule = ruleOf(spec.op)
		const ast = spec.op === "expr" ? parseExpr(spec.formula) : null
		const rows = operandIds(spec, ast).map((id) => lookup(ledger, id, true))
		const context = rule.context(spec)
		const expected = expectedUnit(spec.op, rows, { ast, context: { ...context, rationale: spec.rationale ?? null } })
		const declared = declaredUnit(spec)
		if (declared !== expected) refuse(unitMismatch(spec.op, rows, declared, expected))
		const result = compute(spec.op, rows, expected, ast, context)
		const kind = spec.op === "convert" ? "converted" : "derived"
		const ids = rows.map((row) => row.fact_id)
		const row = addRow(ledger, {
			kind,
			value: result.value,
			unit: expected,
			raw: result.render,
			quote: "",
			extracted_by: "fact-derive",
			observed_at: spec.now ?? new Date().toISOString(),
			label: spec.label ?? `${spec.op}-${nextId(ledger, kind).toLowerCase()}`,
			exact: result.exact,
			render: result.render,
			operation: spec.op,
			operands: ids,
			derived_from: ids,
			formula: ast ? String(spec.formula).trim() : result.formula,
			factor: result.factor,
			rationale: spec.rationale ?? null,
			context,
		})
		return { row, compatibility: spec.op === "expr" ? "unchecked" : "checked" }
	} catch (error) {
		if (!(error instanceof RuleError)) throw error
		return { error: INCOMPATIBLE, detail: error.detail, ...(error.hint ? { hint: error.hint } : {}) }
	}
}

export { compute, lookup }
