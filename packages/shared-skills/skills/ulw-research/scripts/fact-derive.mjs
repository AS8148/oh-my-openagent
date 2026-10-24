// fact-derive.mjs - script-computed derivations and conversions over the fact ledger.
// derive() checks a declared operation's operand rows, computes in exact rationals from each operand's `exact` (never
// its rounded `value`), and appends a derived or converted row. Sums and differences (pp included) render at the
// operands' fewest decimal places, half away from zero (1000 - 3 is 997, 9 - 1.5 is 8, 19.0 - 1.5 is 17.5, 1.25 + 2.5
// is 3.8); every other operation at their fewest significant figures. recompute() repeats the arithmetic so the
// verifier compares exact, value, and render with no epsilon (fact-recompute.mjs). Every failure is incompatible_operands;
// no row is written.

import { addRow, nextId, OPERATIONS } from "./fact-ledger.mjs"
import { unitMismatch } from "./fact-recompute.mjs"
import { add, div, fromDecimal, mul, sigFigsOf, sub, toDecimal } from "./rational.mjs"
import { convertFactor, dimensionOf, normalizeUnit } from "./units.mjs"

export { recompute } from "./fact-recompute.mjs"

const INCOMPATIBLE = "incompatible_operands"
const HUNDRED = fromDecimal("100")
const EXPR_HINT = "currencies never convert by table: add a dated rate row and use --op expr with a rationale"

class DeriveError extends Error {}
const refuse = (detail, hint) => { throw Object.assign(new DeriveError(detail), { detail, hint }) }
const isNonEmpty = (value) => typeof value === "string" && value.trim().length > 0
const unitKey = (unit) => (unit === null || unit === undefined ? null : (normalizeUnit(unit) ?? String(unit).replace(/\s+/g, "")))
const sameDeclared = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null) // null matches only null: null vs "all" is refused
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

function display(value, unit) {
	const [whole, fraction] = value.split(".")
	const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction === undefined ? "" : `.${fraction}`)
	if (unit === null || unit === undefined) return grouped
	return unitKey(unit) === "%" ? `${grouped}%` : `${grouped} ${unit}`
}

function lookup(ledger, id, requireActive) {
	const row = ledger.rows.find((candidate) => candidate.fact_id === id)
	if (!row) refuse(`no ledger row ${id}`)
	if (requireActive && row.status !== "active") refuse(`${id} is ${row.status}`)
	if (row.exact === null || row.value === null) refuse(`${id} has no exact value to derive from`)
	return row
}

const TOKEN = /\s*(?:(F\d+)|(\d+(?:\.\d+)?)|([-+*/()]))/y

function tokenize(formula) {
	const text = String(formula ?? "")
	const tokens = []
	TOKEN.lastIndex = 0
	while (/\S/.test(text.slice(TOKEN.lastIndex))) {
		const at = TOKEN.lastIndex
		const match = TOKEN.exec(text)
		if (!match) refuse(`unsupported expression text at ${at}: "${text.slice(at).trim().slice(0, 16)}"`)
		tokens.push(match[1] ? { id: match[1] } : match[2] ? { literal: match[2] } : { op: match[3] })
	}
	if (tokens.length === 0) refuse("expr needs an expression")
	return tokens
}

/** Recursive descent over + - * / and parentheses; leaves are fact ids and decimal literals. */
function parseExpr(formula) {
	const tokens = tokenize(formula)
	let index = 0
	const primary = () => {
		const token = tokens[index++]
		if (!token) refuse("the expression ends early")
		if (token.id || token.literal) return token
		if (token.op !== "(") refuse(`unexpected "${token.op}" in the expression`)
		const inner = sum()
		if (tokens[index++]?.op !== ")") refuse("the expression is missing a closing parenthesis")
		return inner
	}
	const binary = (next, ops) => () => {
		let left = next()
		while (ops.includes(tokens[index]?.op)) {
			const op = tokens[index++].op
			left = { op, left, right: next() }
		}
		return left
	}
	const product = binary(primary, ["*", "/"])
	const sum = binary(product, ["+", "-"])
	const ast = sum()
	if (index < tokens.length) refuse("unexpected text after the expression")
	return ast
}

function leaves(node, found = { ids: [], literals: [] }) {
	if (node.id && !found.ids.includes(node.id)) found.ids.push(node.id)
	if (node.literal) found.literals.push(node.literal)
	if (node.op) [node.left, node.right].forEach((child) => leaves(child, found))
	return found
}

function evaluate(node, values) {
	if (node.id) return values.get(node.id)
	if (node.literal) return fromDecimal(node.literal)
	const left = evaluate(node.left, values)
	const right = evaluate(node.right, values)
	if (node.op === "/" && right.num === 0n) refuse("the expression divides by zero")
	return { "+": add, "-": sub, "*": mul, "/": div }[node.op](left, right)
}

const nonZero = (r, what) => (r.num === 0n ? refuse(`${what} is zero`) : r)

function convertOf(row, target) {
	const factor = convertFactor(row.unit, target)
	if (!factor) {
		const currency = [row.unit, target].some((unit) => dimensionOf(unit)?.startsWith("currency:"))
		refuse(`${row.fact_id} in ${row.unit} has no table conversion to ${target}`, currency ? EXPR_HINT : undefined)
	}
	if (unitKey(row.unit) === unitKey(target)) refuse(`${row.fact_id} is already in ${target}`)
	const scale = { num: factor.num, den: factor.den }
	const exact = add(mul(toBig(row.exact), scale), factor.offset ?? 0n)
	const factorText = terminates(scale) ? toDecimal(scale) : `${scale.num}/${scale.den}`
	const offset = factor.offset ? ` + ${factor.offset.num}/${factor.offset.den}` : ""
	return { exact, factor: terminates(scale) ? factorText : null, formula: `${row.fact_id} * ${factorText}${offset}` }
}

/** Arithmetic only: the result of `op` over ordered operand rows, as stored on a row. */
function compute(op, rows, unit, ast) {
	const values = rows.map((row) => toBig(row.exact))
	const ids = rows.map((row) => row.fact_id)
	const [a, b] = values
	let sigFigs = Math.min(...rows.map((row) => sigFigsOf(row.value)))
	const percent = unitKey(unit) === "%"
	let out
	if (op === "sum") out = { exact: values.reduce((total, value) => add(total, value)), unit: unit ?? rows[0].unit, formula: ids.join(" + ") }
	else if (op === "diff") out = { exact: sub(a, b), unit: unit ?? rows[0].unit, formula: `${ids[0]} - ${ids[1]}` }
	else if (op === "growth") out = { exact: mul(div(sub(b, a), nonZero(a, ids[0])), HUNDRED), unit: unit ?? "%", formula: `(${ids[1]} - ${ids[0]}) / ${ids[0]} * 100` }
	else if (op === "ratio" || op === "share") {
		const quotient = div(a, nonZero(b, ids[1]))
		const asPercent = percent || (op === "share" && (unit === null || unit === undefined))
		out = { exact: asPercent ? mul(quotient, HUNDRED) : quotient, unit: asPercent ? (unit ?? "%") : (unit ?? null), formula: `${ids[0]} / ${ids[1]}${asPercent ? " * 100" : ""}` }
	} else if (op === "convert") out = { ...convertOf(rows[0], unit), unit }
	else if (op === "expr") {
		const literals = leaves(ast).literals.map((literal) => sigFigsOf(literal))
		sigFigs = Math.min(sigFigs, ...literals)
		out = { exact: evaluate(ast, new Map(ids.map((id, index) => [id, values[index]]))), unit: unit ?? null, formula: null }
	} else refuse(`unknown operation ${op}; use one of ${OPERATIONS.join(", ")}`)
	const byPlaces = op === "sum" || op === "diff"
	const value = renderValue(out.exact, byPlaces ? Math.min(...rows.map((row) => placesOf(row.value))) : sigFigs, byPlaces)
	const shown = display(value, out.unit)
	const render = op === "convert" ? `${shown} (${display(rows[0].value, rows[0].unit)})` : shown
	return { exact: toText(out.exact), value, unit: out.unit, render, formula: out.formula, factor: out.factor ?? null }
}

/** The compatibility predicates of the v2 3c table; expr is never checked and convert checks dimension in compute. */
function checkCompatibility(op, rows, unit, spec) {
	const [first, second] = rows
	const fields = op === "growth" ? ["population", "accounting_basis"] : ["population", "snapshot_window", ...(op === "sum" || op === "diff" ? ["accounting_basis"] : [])]
	for (const field of fields) {
		for (const row of rows.slice(1)) {
			if (!sameDeclared(first[field], row[field])) refuse(`${field} differs: ${first.fact_id} ${JSON.stringify(first[field])} vs ${row.fact_id} ${JSON.stringify(row[field])}`)
		}
	}
	const units = rows.map((row) => unitKey(row.unit))
	if (op !== "ratio" && units.some((key) => key !== units[0])) refuse(`unit differs across ${rows.map((row) => `${row.fact_id} ${row.unit}`).join(", ")}`)
	if (op === "sum" || op === "diff") {
		if (units[0] === "%" && op === "diff" && unitKey(unit) !== "%p") refuse("a difference of % operands is in percentage points: pass unit pp")
		if (units[0] === "%" && op === "sum" && !(spec.disjoint === true && isNonEmpty(spec.rationale))) refuse("summing % operands needs disjoint shares: pass disjoint and a rationale")
		if (units[0] !== "%" && unit !== null && unit !== undefined && unitKey(unit) !== units[0]) refuse(`result unit ${unit} differs from the operands' ${first.unit}`)
	}
	if (op === "growth") {
		if (first.entity === null || first.entity !== second.entity) refuse(`growth needs one declared entity: ${first.fact_id} ${first.entity} vs ${second.fact_id} ${second.entity}`)
		if (first.valid_at === null || second.valid_at === null || first.valid_at === second.valid_at) refuse(`growth needs two different valid_at periods: ${first.valid_at} vs ${second.valid_at}`)
		if (toBig(first.exact).num <= 0n) refuse(`growth needs a positive starting value in ${first.fact_id}`)
	}
	if ((op === "growth" || op === "share") && unit !== null && unit !== undefined && unitKey(unit) !== "%") refuse(`${op} is in %`)
}

function operandIds(spec, ast) {
	if (spec.op === "growth") return [spec.from, spec.to]
	if (spec.op === "ratio") return [spec.num, spec.den]
	if (spec.op === "share") return [spec.part, spec.whole]
	if (spec.op === "expr") return leaves(ast).ids
	const ids = Array.isArray(spec.operands) ? spec.operands : []
	const arity = { sum: ids.length >= 2, diff: ids.length === 2, convert: ids.length === 1 }
	if (!arity[spec.op]) refuse(`${spec.op} takes ${spec.op === "sum" ? "two or more operands" : spec.op === "diff" ? "two operands" : "one operand"}`)
	return ids
}

/**
 * @returns {{row: object, compatibility: "checked" | "unchecked"} | {error: "incompatible_operands", detail: string, hint?: string}}
 */
export function derive(ledger, spec) {
	try {
		if (!OPERATIONS.includes(spec.op)) refuse(`unknown operation ${spec.op}; use one of ${OPERATIONS.join(", ")}`)
		const ast = spec.op === "expr" ? parseExpr(spec.formula) : null
		if (spec.op === "expr" && !isNonEmpty(spec.rationale)) refuse("expr is unchecked and needs a rationale")
		const rows = operandIds(spec, ast).map((id) => lookup(ledger, id, true))
		const unit = spec.op === "convert" ? (spec.to ?? spec.unit) : (spec.unit ?? null)
		if (spec.op !== "expr" && spec.op !== "convert") checkCompatibility(spec.op, rows, unit, spec)
		const result = compute(spec.op, rows, unit, ast)
		const mismatch = unitMismatch(spec.op, rows, result.unit, ast)
		if (mismatch) refuse(mismatch)
		const kind = spec.op === "convert" ? "converted" : "derived"
		const ids = rows.map((row) => row.fact_id)
		const row = addRow(ledger, {
			kind,
			value: result.value,
			unit: result.unit,
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
		})
		return { row, compatibility: spec.op === "expr" ? "unchecked" : "checked" }
	} catch (error) {
		if (!(error instanceof DeriveError)) throw error
		return { error: INCOMPATIBLE, detail: error.detail, ...(error.hint ? { hint: error.hint } : {}) }
	}
}

export { compute, DeriveError, leaves, lookup, parseExpr, unitKey }
