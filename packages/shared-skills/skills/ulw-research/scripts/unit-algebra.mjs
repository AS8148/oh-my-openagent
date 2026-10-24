// unit-algebra.mjs - canonical unit text for derived facts (references/unit-rules.md).
// canonicalUnit() is the INPUT canonicalizer: table aliases become their token (units.mjs), and a composite such as
// "USD / (USD/person)" is rebuilt algebraically with equal factors cancelled ("person"; "m/m" is null, dimensionless);
// whitespace is trimmed only around operators, so unit text with no alias ("metric ton") is stored as given.
// Stored rows are compared against canonical text exactly, so an alias written onto a row at rest is a relabel.
// RuleError is the one refusal type of the derivation modules: a detail and an optional hint.

import { dimensionOf, normalizeUnit } from "./units.mjs"

export class RuleError extends Error {
	constructor(detail, hint) {
		super(detail)
		this.detail = detail
		if (hint) this.hint = hint
	}
}

export const refuse = (detail, hint) => {
	throw new RuleError(detail, hint)
}

/** Aliases whose numerals need rescaling at input: 1 basis point is 0.01 percentage points. */
const SCALED_ALIASES = Object.freeze({ bp: Object.freeze({ unit: "%p", scale: "0.01" }), basispoint: Object.freeze({ unit: "%p", scale: "0.01" }), basispoints: Object.freeze({ unit: "%p", scale: "0.01" }) })

const squash = (text) => text.replace(/\s+/g, "")
const PERCENTISH = new Set(["%", "%p"])

export const isPercentish = (unit) => PERCENTISH.has(unit)

/** The scale an input alias applies to its numeral ("0.01" for bp), or null when it applies none. */
export function inputScale(raw) {
	return typeof raw === "string" ? (SCALED_ALIASES[squash(raw).toLowerCase()]?.scale ?? null) : null
}

/** A table alias becomes its token; any other atom is kept as given, inner whitespace included ("million people"). */
function atomOf(text) {
	if (text === "1") return null
	return SCALED_ALIASES[squash(text).toLowerCase()]?.unit ?? normalizeUnit(text) ?? text
}

/** Parse unit text into factor exponents; `*`, `/`, `^n`, and parentheses, left to right; whitespace trims around them. */
function factorsOf(text) {
	const tokens = (text.match(/[*/()^]|[^*/()^]+/g) ?? []).map((token) => token.trim()).filter(Boolean)
	let index = 0
	const combine = (into, from, sign) => {
		for (const [atom, power] of from) into.set(atom, (into.get(atom) ?? 0) + sign * power)
		return into
	}
	const primary = () => {
		const token = tokens[index++]
		if (token === undefined) refuse(`unit "${text}" ends early`)
		let factors
		if (token === "(") {
			factors = product()
			if (tokens[index++] !== ")") refuse(`unit "${text}" is missing a closing parenthesis`)
		} else if (/^[*/()^]$/.test(token)) refuse(`unexpected "${token}" in unit "${text}"`)
		else {
			const atom = atomOf(token)
			factors = new Map(atom === null ? [] : [[atom, 1]])
		}
		if (tokens[index] === "^") {
			index++
			const power = Number(tokens[index++])
			if (!Number.isInteger(power) || power === 0) refuse(`unit "${text}" has a bad exponent`)
			factors = combine(new Map(), factors, power)
		}
		return factors
	}
	const product = () => {
		let factors = primary()
		while (tokens[index] === "*" || tokens[index] === "/") {
			const sign = tokens[index++] === "*" ? 1 : -1
			factors = combine(factors, primary(), sign)
		}
		return factors
	}
	const factors = product()
	if (index < tokens.length) refuse(`unexpected text in unit "${text}"`)
	return factors
}

/** Canonical text of factor exponents: sorted numerator factors, then "/" and the denominator; null when all cancel. */
function format(factors) {
	const side = (sign) =>
		[...factors]
			.filter(([, power]) => Math.sign(power) === sign)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([atom, power]) => (Math.abs(power) === 1 ? atom : `${atom}^${Math.abs(power)}`))
	const top = side(1)
	const bottom = side(-1)
	if (top.length === 0 && bottom.length === 0) return null
	const numerator = top.join("*") || "1"
	if (bottom.length === 0) return numerator
	return `${numerator}/${bottom.length === 1 ? bottom[0] : `(${bottom.join("*")})`}`
}

/** Canonical unit text for an input unit: null stays null (dimensionless); refuses a non-string or bad syntax. */
export function canonicalUnit(raw) {
	if (raw === null) return null
	if (typeof raw !== "string" || raw.trim() === "") refuse(`unit ${JSON.stringify(raw ?? null)} is not unit text or null`)
	return format(factorsOf(raw))
}

const factorsOfCanonical = (unit) => (unit === null ? new Map() : factorsOf(unit))

/** Canonical product and quotient of two canonical units, factors cancelled. */
export function unitTimes(a, b) {
	const out = factorsOfCanonical(a)
	for (const [atom, power] of factorsOfCanonical(b)) out.set(atom, (out.get(atom) ?? 0) + power)
	return format(out)
}

export function unitOver(a, b) {
	const out = factorsOfCanonical(a)
	for (const [atom, power] of factorsOfCanonical(b)) out.set(atom, (out.get(atom) ?? 0) - power)
	return format(out)
}

/** Affine scales (temperature) have an offset zero, so growth, share, ratio, and products refuse them. */
export function isAffine(unit) {
	return typeof unit === "string" && dimensionOf(unit) === "temperature"
}
