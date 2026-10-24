// fact-recompute.mjs - the tamper detector for derived and converted fact rows.
// recompute() checks the row's shape with the operation registry (unit-rules.mjs), verifies derived operands
// recursively (a cycle is refused), re-derives the result unit with the same registry derive() uses, and repeats the
// arithmetic, comparing unit text, exact, value, and render with no epsilon. A convert row is checked against its
// persisted context.target, never against its own `unit`. It never throws: a malformed row is ok:false with a detail.

import { compute, lookup } from "./fact-derive.mjs"
import { parseExpr } from "./fact-expr.mjs"
import { RuleError } from "./unit-algebra.mjs"
import { expectedUnit, malformed, unitMismatch } from "./unit-rules.mjs"

const fail = (detail, expected = null) => ({ ok: false, expected, detail })
const isDerived = (row) => row.operation !== null && row.operation !== undefined

function check(ledger, row, visiting) {
	const shape = malformed(row)
	if (shape) return fail(`${row?.fact_id}: ${shape}`)
	if (visiting.has(row.fact_id)) return fail(`${row.fact_id}: operands form a cycle through ${[...visiting, row.fact_id].join(" -> ")}`)
	const path = new Set([...visiting, row.fact_id])
	try {
		const rows = row.operands.map((id) => lookup(ledger, id, false))
		for (const operand of rows.filter(isDerived)) {
			const inner = check(ledger, operand, path)
			if (!inner.ok) return fail(`${row.fact_id}: operand ${operand.fact_id} does not recompute: ${inner.detail ?? "its stored values differ"}`)
		}
		const ast = row.operation === "expr" ? parseExpr(row.formula) : null
		const context = { ...(row.context ?? {}), rationale: row.rationale ?? null }
		const unit = expectedUnit(row.operation, rows, { ast, context })
		const result = compute(row.operation, rows, unit, ast, context)
		const expected = { unit, exact: result.exact, value: result.value, render: result.render }
		if (row.unit !== unit) return fail(`${row.fact_id}: ${unitMismatch(row.operation, rows, row.unit, unit)}`, expected)
		const ok = result.exact.num === row.exact.num && result.exact.den === row.exact.den && result.value === row.value && result.render === row.render
		return ok ? { ok, expected } : { ok, expected, detail: `${row.fact_id}: stored exact, value, or render differs from the recomputed result` }
	} catch (error) {
		if (error instanceof RuleError) return fail(`${row.fact_id}: ${error.detail}`)
		return fail(`${row.fact_id}: malformed row: ${error instanceof Error ? error.message : String(error)}`)
	}
}

/** Repeat a stored row's arithmetic; ok only when its unit follows from the operands and exact, value, and render match. */
export function recompute(ledger, row) {
	return check(ledger, row, new Set())
}
