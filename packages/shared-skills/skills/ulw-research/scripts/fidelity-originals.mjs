// Check displayed conversion originals against their operands, not the mutable render field.
import { sameValue, unitKey } from "./fidelity-binding.mjs"
import { parseNumeral } from "./numerals.mjs"
import { normalizeText } from "./text-normalize.mjs"
import { display } from "./unit-precision.mjs"

export function originalProblem(row, shown, rows) {
	if (!["converted", "derived"].includes(row.kind)) return null
	const originals = [...String(shown).matchAll(/\(([^()]*)\)/g)]
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
