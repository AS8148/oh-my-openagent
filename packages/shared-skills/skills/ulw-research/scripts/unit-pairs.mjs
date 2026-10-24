// unit-pairs.mjs - the typed operand-unit rules shared by the operation registry and expr nodes (references/unit-rules.md).
// equalUnits and notAffine guard whole operations; minusUnit and plusUnit are the typed-pair rules that diff and sum
// use and that expr's `-` and `+` nodes follow; inferExpr assigns a canonical unit to every node of an expr tree.

import { isAffine, isPercentish, refuse, unitOver, unitTimes } from "./unit-algebra.mjs"

export const show = (unit) => JSON.stringify(unit ?? null)
export const listed = (rows, units) => rows.map((row, index) => `${row.fact_id} ${units[index] ?? "null"}`).join(", ")

export function equalUnits(rows, units) {
	if (units.some((unit) => unit !== units[0])) refuse(`unit differs across ${listed(rows, units)}`)
	return units[0]
}

export function notAffine(op, rows, units) {
	if (units.some(isAffine)) refuse(`${op} refuses affine (temperature) units: ${listed(rows, units)}`)
}

/** The typed-pair rule shared by diff and expr `-`: U-U is U; %-% is %p; %-%p is %; %p-%p is %p; %p-% is refused. */
export function minusUnit(a, b, where) {
	if (isAffine(a) || isAffine(b)) refuse(`${where}: subtracting affine (temperature) values as absolute values has no meaning`)
	if (a === b) return a === "%" ? "%p" : a
	if (a === "%" && b === "%p") return "%"
	refuse(`${where}: ${show(a)} - ${show(b)} is not a typed pair (U-U, %-%, %-%p, %p-%p)`)
}

export function plusUnit(a, b, where) {
	if (isAffine(a) || isAffine(b)) refuse(`${where}: adding affine (temperature) values has no meaning`)
	if (a === b && a === "%") refuse(`${where}: adding % values needs disjoint shares of one reference: use --op sum`)
	if (a === b) return a
	if ((a === "%" && b === "%p") || (a === "%p" && b === "%")) return "%"
	refuse(`${where}: ${show(a)} + ${show(b)} has no common unit`)
}

/** Unit of every node of an expr tree; refuses when a node's unit cannot be inferred. */
export function inferExpr(ast, unitsById) {
	const units = new Map()
	const visit = (node) => {
		let unit
		if (node.id) unit = unitsById.get(node.id)
		else if (node.literal) unit = null
		else if (node.fn === "pct") {
			unit = visit(node.arg)
			if (unit !== null) refuse(`pct() takes a dimensionless value, got ${show(unit)}`)
			unit = "%"
		} else {
			const left = visit(node.left)
			const right = visit(node.right)
			if (node.op === "+") unit = plusUnit(left, right, "expr")
			else if (node.op === "-") unit = minusUnit(left, right, "expr")
			else {
				if (isAffine(left) || isAffine(right)) refuse(`expr: ${node.op} on affine (temperature) units has no meaning`)
				const fraction = (value) => (isPercentish(value) ? null : value)
				unit = (node.op === "*" ? unitTimes : unitOver)(fraction(left), fraction(right))
			}
		}
		units.set(node, unit)
		return unit
	}
	return { unit: visit(ast), units }
}
