// unit-rules.mjs - the one operation registry for derived facts (references/unit-rules.md).
// Per operation: arity, operand ids, the context persisted on the row, the metadata that must match, the operand
// guards and result unit (resultUnit), and the row shape check (malformed). derive() and recompute() both call it and
// carry no op-specific unit code. Units are chosen from operand units only; numeric guards may read `exact`.

import { leaves, parseExpr } from "./fact-expr.mjs"
import { canonicalUnit, inputScale, isAffine, isPercentish, refuse, RuleError, unitOver, unitTimes } from "./unit-algebra.mjs"
import { convertFactor, dimensionOf } from "./units.mjs"

export { canonicalUnit, isAffine, RuleError }

const EXPR_HINT = "currencies never convert by table: add a dated rate row and use --op expr"
const isNonEmpty = (value) => typeof value === "string" && value.trim().length > 0
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const toBig = (exact) => ({ num: BigInt(exact.num), den: BigInt(exact.den) })
const compare = (a, b) => a.num * b.den - b.num * a.den
const sameDeclared = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null) // null matches only null
const listed = (rows, units) => rows.map((row, index) => `${row.fact_id} ${units[index] ?? "null"}`).join(", ")
const show = (unit) => JSON.stringify(unit ?? null)

function equalUnits(rows, units) {
	if (units.some((unit) => unit !== units[0])) refuse(`unit differs across ${listed(rows, units)}`)
	return units[0]
}

function notAffine(op, rows, units) {
	if (units.some(isAffine)) refuse(`${op} refuses affine (temperature) units: ${listed(rows, units)}`)
}

function sharedReference(rows, reference) {
	if (isNonEmpty(reference)) return
	if (isObject(reference)) {
		const named = rows.map((row) => reference[row.fact_id])
		if (named.every(isNonEmpty) && named.every((value) => value === named[0])) return
		refuse(`% operands name different references: ${rows.map((row, index) => `${row.fact_id} ${show(named[index])}`).join(", ")}`)
	}
	refuse("summing % operands needs one shared reference (denominator): pass reference")
}

/** The typed-pair rule shared by diff and expr `-`: U-U is U; %-% is %p; %-%p is %; %p-%p is %p; %p-% is refused. */
function minusUnit(a, b, where) {
	if (a === b) return a === "%" ? "%p" : a
	if (a === "%" && b === "%p") return "%"
	refuse(`${where}: ${show(a)} - ${show(b)} is not a typed pair (U-U, %-%, %-%p, %p-%p)`)
}

function plusUnit(a, b, where) {
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

const pair = (a, b) => (spec) => [spec[a], spec[b]]
const listOf = (spec) => spec.operands
const needsContext = (row) => (isObject(row.context) ? null : `${row.operation} rows carry a context object, got ${show(row.context)}`)
const SNAPSHOT = ["population", "snapshot_window"]

function exprShape(row) {
	try {
		const ids = leaves(parseExpr(row.formula)).ids
		const operands = row.operands
		if (ids.some((id) => !operands.includes(id)) || operands.some((id) => !ids.includes(id))) return `formula ids ${ids.join(", ")} do not match operands ${operands.join(", ")}`
		return null
	} catch (error) {
		if (error instanceof RuleError) return error.detail
		throw error
	}
}

/** The operation table of references/unit-rules.md, one entry per operation, iterable. */
export const OPERATION_RULES = Object.freeze({
	sum: Object.freeze({
		arity: (n) => n >= 2,
		arityText: "two or more operands",
		operandIds: listOf,
		context: (spec) => ({ disjoint: spec.disjoint === true, reference: spec.reference ?? null }),
		metadata: [...SNAPSHOT, "accounting_basis"],
		resultUnit(rows, units, context) {
			const unit = equalUnits(rows, units)
			if (unit === "%") {
				if (context.disjoint !== true) refuse("summing % operands needs disjoint shares: pass disjoint")
				sharedReference(rows, context.reference)
				if (!isNonEmpty(context.rationale)) refuse("summing % operands needs a rationale for the disjoint shares")
			}
			return unit
		},
		malformed: needsContext,
	}),
	diff: Object.freeze({
		arity: (n) => n === 2,
		arityText: "two operands",
		operandIds: listOf,
		context: () => null,
		metadata: [...SNAPSHOT, "accounting_basis"],
		resultUnit: (rows, units) => minusUnit(units[0], units[1], `diff ${listed(rows, units)}`),
	}),
	growth: Object.freeze({
		arity: (n) => n === 2,
		arityText: "two operands (from, to)",
		operandIds: pair("from", "to"),
		context: () => null,
		metadata: ["population", "accounting_basis"],
		resultUnit(rows, units) {
			const [from, to] = rows
			notAffine("growth", rows, units)
			equalUnits(rows, units)
			if (from.entity === null || from.entity === undefined || from.entity !== to.entity) refuse(`growth needs one declared entity: ${from.fact_id} ${from.entity} vs ${to.fact_id} ${to.entity}`)
			if (!from.valid_at || !to.valid_at || from.valid_at === to.valid_at) refuse(`growth needs two different valid_at periods: ${from.valid_at} vs ${to.valid_at}`)
			if (toBig(from.exact).num <= 0n) refuse(`growth needs a positive starting value in ${from.fact_id}`)
			return "%"
		},
	}),
	share: Object.freeze({
		arity: (n) => n === 2,
		arityText: "two operands (part, whole)",
		operandIds: pair("part", "whole"),
		context: () => null,
		metadata: SNAPSHOT,
		resultUnit(rows, units) {
			notAffine("share", rows, units)
			equalUnits(rows, units)
			const [part, whole] = rows.map((row) => toBig(row.exact))
			if (whole.num <= 0n) refuse(`share needs a positive whole in ${rows[1].fact_id}`)
			if (part.num < 0n || compare(part, whole) > 0n) refuse(`share needs 0 <= part <= whole: ${rows[0].fact_id} is outside [0, ${rows[1].fact_id}]`)
			return "%"
		},
	}),
	ratio: Object.freeze({
		arity: (n) => n === 2,
		arityText: "two operands (num, den)",
		operandIds: pair("num", "den"),
		context: () => null,
		metadata: SNAPSHOT,
		resultUnit(rows, units) {
			notAffine("ratio", rows, units)
			if (toBig(rows[1].exact).num === 0n) refuse(`ratio denominator ${rows[1].fact_id} is zero`)
			if (units[0] === units[1]) return null
			if (units.some(isPercentish)) refuse(`a ratio over % or %p needs equal units: ${listed(rows, units)}; use expr`)
			return unitOver(units[0], units[1])
		},
	}),
	convert: Object.freeze({
		arity: (n) => n === 1,
		arityText: "one operand",
		operandIds: listOf,
		context: (spec) => ({ target: spec.to === undefined || spec.to === null ? null : canonicalUnit(spec.to) }),
		metadata: [],
		resultUnit(rows, units, context) {
			if (!isNonEmpty(context.target)) refuse("convert needs a target unit")
			const [from] = units
			const target = context.target
			if (from === target) refuse(`${rows[0].fact_id} is already in ${target}`)
			if ([from, target].some((unit) => dimensionOf(unit)?.startsWith("currency:"))) refuse(`${rows[0].fact_id} in ${show(from)} has no table conversion to ${target}`, EXPR_HINT)
			if (!convertFactor(from, target)) refuse(`${rows[0].fact_id} in ${show(from)} has no table conversion to ${target}`)
			return target
		},
		malformed: (row) => needsContext(row) ?? (isNonEmpty(row.context.target) ? null : "a convert row carries its target in context.target"),
	}),
	expr: Object.freeze({
		arity: (n) => n >= 1,
		arityText: "one or more operands",
		operandIds: (spec, ast) => leaves(ast).ids,
		context: () => null,
		metadata: [],
		resultUnit: (rows, units, context, ast) => inferExpr(ast, new Map(rows.map((row, index) => [row.fact_id, units[index]]))).unit,
		malformed: exprShape,
	}),
})

export function ruleOf(op) {
	if (!Object.hasOwn(OPERATION_RULES, op)) refuse(`unknown operation ${op}; use one of ${Object.keys(OPERATION_RULES).join(", ")}`)
	return OPERATION_RULES[op]
}

/** A stored operand's unit as the registry reads it; a scaled alias (bp) must be stored rescaled first. */
export function operandUnit(row) {
	if (inputScale(row.unit)) refuse(`${row.fact_id} is in ${row.unit}; store it as %p (times ${inputScale(row.unit)}) before deriving`)
	return canonicalUnit(row.unit ?? null)
}

/** The canonical result unit of `op` over operand rows, after every metadata and operand guard; refuses otherwise. */
export function expectedUnit(op, rows, { ast = null, context = null } = {}) {
	const rule = ruleOf(op)
	if (!rule.arity(rows.length)) refuse(`${op} takes ${rule.arityText}, got ${rows.length}`)
	const units = rows.map(operandUnit)
	for (const field of rule.metadata) {
		for (const row of rows.slice(1)) {
			if (!sameDeclared(rows[0][field], row[field])) refuse(`${field} differs: ${rows[0].fact_id} ${show(rows[0][field])} vs ${row.fact_id} ${show(row[field])}`)
		}
	}
	return rule.resultUnit(rows, units, context ?? {}, op === "expr" ? (ast ?? refuse("expr needs its parsed formula")) : null)
}

export function unitMismatch(op, rows, unit, expected) {
	return `unit ${show(unit)} does not follow from ${op} over ${rows.map((row) => `${row.fact_id} ${row.unit ?? "null"}`).join(", ")}: expected unit ${show(expected)}`
}

/** Why a stored derived row cannot be recomputed as stored, before any ledger lookup; null when its shape is sound. */
export function malformed(row) {
	if (!isObject(row)) return "the row is not an object"
	if (!Object.hasOwn(OPERATION_RULES, row.operation)) return `operation ${show(row.operation)} is not one of ${Object.keys(OPERATION_RULES).join(", ")}`
	const rule = OPERATION_RULES[row.operation]
	const { operands, exact } = row
	if (!Array.isArray(operands) || operands.length === 0 || !operands.every(isNonEmpty)) return `operands must be a non-empty array of fact ids, got ${show(operands)}`
	if (!rule.arity(operands.length)) return `${row.operation} takes ${rule.arityText}, got ${operands.length}`
	if (!isObject(exact) || !/^-?\d+$/.test(String(exact.num)) || !/^[1-9]\d*$/.test(String(exact.den))) return `exact must be { num, den } integer strings, got ${show(exact)}`
	return rule.malformed?.(row) ?? null
}
