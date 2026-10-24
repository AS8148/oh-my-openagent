// fact-expr.mjs - the expression language of `fact derive --op expr` (references/unit-rules.md, expr row).
// Leaves are fact ids and decimal literals; nodes are + - * / and pct(x), the explicit dimensionless-to-% node.
// evaluate() is exact rational arithmetic. Under * and / a child whose inferred unit is % or %p enters as its
// fraction (20% as 0.2): that unit comes from the registry's inference over the operand rows, never from the row's
// own declared unit.

import { add, div, fromDecimal, mul, sub } from "./rational.mjs"
import { isPercentish, refuse } from "./unit-algebra.mjs"

const TOKEN = /\s*(?:(F\d+)|(\d+(?:\.\d+)?)|(pct)\b|([-+*/()]))/y
const HUNDRED = fromDecimal("100")

function tokenize(formula) {
	const text = String(formula ?? "")
	const tokens = []
	TOKEN.lastIndex = 0
	while (/\S/.test(text.slice(TOKEN.lastIndex))) {
		const at = TOKEN.lastIndex
		const match = TOKEN.exec(text)
		if (!match) refuse(`unsupported expression text at ${at}: "${text.slice(at).trim().slice(0, 16)}"`)
		tokens.push(match[1] ? { id: match[1] } : match[2] ? { literal: match[2] } : match[3] ? { fn: "pct" } : { op: match[4] })
	}
	if (tokens.length === 0) refuse("expr needs an expression")
	return tokens
}

/** Recursive descent over + - * /, parentheses, and pct(...). */
export function parseExpr(formula) {
	const tokens = tokenize(formula)
	let index = 0
	const group = () => {
		if (tokens[index++]?.op !== "(") refuse("pct needs a parenthesized argument")
		const inner = sum()
		if (tokens[index++]?.op !== ")") refuse("the expression is missing a closing parenthesis")
		return inner
	}
	const primary = () => {
		const token = tokens[index]
		if (!token) refuse("the expression ends early")
		if (token.id || token.literal) return tokens[index++]
		if (token.fn) {
			index++
			return { fn: token.fn, arg: group() }
		}
		if (token.op !== "(") refuse(`unexpected "${token.op}" in the expression`)
		return group()
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

const childrenOf = (node) => (node.op ? [node.left, node.right] : node.fn ? [node.arg] : [])

export function leaves(node, found = { ids: [], literals: [] }) {
	if (node.id && !found.ids.includes(node.id)) found.ids.push(node.id)
	if (node.literal) found.literals.push(node.literal)
	for (const child of childrenOf(node)) leaves(child, found)
	return found
}

/** Exact value of the tree; `units` maps each node to its inferred canonical unit (inferExpr in unit-rules.mjs). */
export function evaluate(node, values, units) {
	if (node.id) return values.get(node.id)
	if (node.literal) return fromDecimal(node.literal)
	if (node.fn === "pct") return mul(evaluate(node.arg, values, units), HUNDRED)
	const operand = (child) => {
		const value = evaluate(child, values, units)
		return (node.op === "*" || node.op === "/") && isPercentish(units.get(child)) ? div(value, HUNDRED) : value
	}
	const left = operand(node.left)
	const right = operand(node.right)
	if (node.op === "/" && right.num === 0n) refuse("the expression divides by zero")
	return { "+": add, "-": sub, "*": mul, "/": div }[node.op](left, right)
}
