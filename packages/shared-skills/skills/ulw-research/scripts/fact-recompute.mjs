// fact-recompute.mjs - the tamper detector for derived and converted fact rows.
// recompute() repeats a stored row's arithmetic from its operands' exact values and compares exact, value, and render
// with no epsilon. It re-derives the result unit from the operands (unitMismatch, which derive() also applies), so a
// relabel whose render was edited to match is caught. It never throws: a malformed row is ok:false with a detail.

import { compute, DeriveError, leaves, lookup, parseExpr, unitKey } from "./fact-derive.mjs"
import { dimensionOf } from "./units.mjs"

const DIMENSIONLESS = new Set(["percent", "percentage-point", "multiple"])
const ARITY = { diff: 2, growth: 2, ratio: 2, share: 2, convert: 1 }
const PERCENTISH = new Set(["%", "%p"])

/** The unit key an expression implies: null when dimensionless, undefined when its operand units do not settle it. */
function exprUnit(node, units) {
	if (node.id) return units.get(node.id)
	if (node.literal) return null
	const left = exprUnit(node.left, units)
	const right = exprUnit(node.right, units)
	if (left === undefined || right === undefined) return undefined
	if (node.op === "+" || node.op === "-") return left === right ? left : undefined
	if (node.op === "*") return left === null ? right : right === null ? left : undefined
	return right === null ? left : left === right ? null : undefined
}

function exprAccepts(inferred, unit) {
	const key = unitKey(unit)
	if (inferred === undefined) return true
	if (inferred === null) return key === null || dimensionOf(unit) === null || DIMENSIONLESS.has(dimensionOf(unit))
	return PERCENTISH.has(inferred) ? PERCENTISH.has(key) : key === inferred
}

/** Why `unit` cannot be the result unit of `op` over `rows`, or null when it follows from them. */
export function unitMismatch(op, rows, unit, ast) {
	const first = unitKey(rows[0]?.unit)
	let want
	if (op === "sum") want = first
	else if (op === "diff") want = first === "%" ? "%p" : first
	else if (op === "growth" || op === "share") want = "%"
	else if (op === "expr") {
		want = exprUnit(ast, new Map(rows.map((row) => [row.fact_id, unitKey(row.unit)])))
		if (exprAccepts(want, unit)) return null
	} else return null
	if (op !== "expr" && unitKey(unit) === want) return null
	const operands = rows.map((row) => `${row.fact_id} ${row.unit}`).join(", ")
	return `unit ${JSON.stringify(unit ?? null)} does not follow from ${op} over ${operands}: expected ${want === null ? "no unit or a dimensionless one" : want}`
}

const fail = (detail, expected = null) => ({ ok: false, expected, detail })

/** Check the row's shape before any arithmetic: a verifier walks every row and must get a result for each. */
function shapeProblem(row) {
	const { operands, operation } = row
	if (!Array.isArray(operands) || operands.length === 0 || !operands.every((id) => typeof id === "string" && id.length > 0)) {
		return `operands must be a non-empty array of fact ids, got ${JSON.stringify(operands ?? null)}`
	}
	const arity = ARITY[operation]
	if (arity ? operands.length !== arity : operation === "sum" && operands.length < 2) {
		return `${operation} takes ${arity ?? "two or more"} operand(s), got ${operands.length}`
	}
	return null
}

/** Repeat a stored row's arithmetic; ok only when the unit follows from the operands and exact, value, and render match. */
export function recompute(ledger, row) {
	if (row === null || typeof row !== "object") return fail("the row is not an object")
	const shape = shapeProblem(row)
	if (shape) return fail(`${row.fact_id}: ${shape}`)
	try {
		const ast = row.operation === "expr" ? parseExpr(row.formula) : null
		if (ast) {
			const ids = leaves(ast).ids
			if (ids.some((id) => !row.operands.includes(id)) || row.operands.some((id) => !ids.includes(id))) {
				return fail(`${row.fact_id}: formula ids ${ids.join(", ")} do not match operands ${row.operands.join(", ")}`)
			}
		}
		const rows = row.operands.map((id) => lookup(ledger, id, false))
		const result = compute(row.operation, rows, row.unit, ast)
		const expected = { exact: result.exact, value: result.value, render: result.render }
		const mismatch = unitMismatch(row.operation, rows, row.unit, ast)
		if (mismatch) return fail(`${row.fact_id}: ${mismatch}`, expected)
		const ok = result.exact.num === row.exact?.num && result.exact.den === row.exact?.den && result.value === row.value && result.render === row.render
		return { ok, expected }
	} catch (error) {
		if (error instanceof DeriveError) return fail(error.detail)
		return fail(`${row.fact_id}: malformed row: ${error instanceof Error ? error.message : String(error)}`)
	}
}
