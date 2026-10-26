// Check displayed conversion originals against their operands, not the mutable render field.
import { sameValue, unitKey } from "./fidelity-binding.mjs"
import { parseNumeral } from "./numerals.mjs"
import { normalizeText } from "./text-normalize.mjs"
import { display } from "./unit-precision.mjs"

const DERIVED = new Set(["converted", "derived"])
const bracketed = (shown) => [...String(shown).matchAll(/\(([^()]*)\)/g)].filter((match) => /\d/.test(match[1]))

/** The converted half (the text outside numeric originals) equals display(row.value, row.unit), rebuilt from the row. */
export function convertedHalfFits(row, shown) {
	if (!DERIVED.has(row.kind) || row.value === null || row.value === undefined) return false
	const half = bracketed(shown).reduce((text, match) => text.replace(match[0], ""), String(shown))
	const expected = normalizeText(display(String(row.value), row.unit ?? null))
	const text = normalizeText(half)
	return text === expected || (text.endsWith(` ${expected}`) && !/\d/.test(text.slice(0, -expected.length)))
}

export function originalProblem(row, shown, rows) {
	if (!DERIVED.has(row.kind)) return null
	const originals = bracketed(shown)
	if (String(shown).replace(/\([^()]*\)/g, "").match(/[()]/)) return ["value_mismatch", "original parentheses are malformed", "original"]
	if (originals.length === 0) return null
	const operands = (row.derived_from ?? []).map((id) => rows.get(id))
	for (const [index, match] of originals.entries()) {
		const operand = operands[index]
		const parsed = parseNumeral(match[1])
		if (!operand || !parsed || !sameValue(parsed.value, operand.value)) return ["value_mismatch", `original "${match[1]}" differs from operand ${operand?.fact_id ?? index}`, "original"]
		if (unitKey(parsed.unitRaw ?? "") !== unitKey(operand.unit ?? "")) return ["unit_mismatch", `original "${match[1]}" is not in ${operand.unit}`, "original"]
		const expected = normalizeText(display(operand.value, operand.unit ?? null))
		if (normalizeText(match[1]) !== expected) return ["value_mismatch", `original "${match[1]}" differs from "${expected}"`, "original"]
	}
	return null
}
