// Value-mode units live outside the fact element: bind only its next text node,
// or the same column's table header. Unknown words are advisory, never guessed units.
import { unitKey } from "./fidelity-binding.mjs"
import { proseText } from "./html-lite.mjs"
import { normalizeUnit } from "./units.mjs"

function followingUnit(text) {
	const token = /^\s+([^\s,.;:!?()[\]]+(?:\s+[^\s,.;:!?()[\]]+){0,2})/u.exec(text)?.[1]
	if (!token) return null
	const words = token.split(/\s+/u)
	for (let n = words.length; n > 0; n--) {
		const unit = normalizeUnit(words.slice(0, n).join(" "))
		if (unit) return unit
	}
	return null
}

function headerUnit(ctx, node) {
	const cell = ctx.util.closest(node, (cur) => cur.tag === "td")
	const table = cell && ctx.util.closest(cell, (cur) => cur.tag === "table")
	if (!table || cell.attrs.colspan || cell.attrs.rowspan) return null
	const cells = (row) => row.children.filter((cur) => cur.tag === "td" || cur.tag === "th")
	const column = cells(cell.parent).indexOf(cell)
	const header = ctx.util.descendants(table).find((cur) => cur.tag === "tr")
	if (!header || header === cell.parent) return null
	const headers = cells(header)
	if (headers.some((cur) => cur.attrs.colspan || cur.attrs.rowspan)) return null
	const text = headers[column] ? proseText(headers[column]) : ""
	const label = /\(([^()]+)\)\s*$/u.exec(text)?.[1] ?? text
	return normalizeUnit(label) ?? followingUnit(` ${label.split(/\s+/u).at(-1)}`)
}

/** A mode marker written by fill distinguishes value-only output from full/unit modes. */
export function valueUnitProblem(ctx, node, row) {
	if (node.attrs["data-fact-mode"] !== "value" || !unitKey(row.unit)) return null
	const siblings = node.parent.children
	const next = siblings[siblings.indexOf(node) + 1]
	const adjacent = next?.tag === "#text" ? followingUnit(next.text) : null
	const unit = adjacent ?? headerUnit(ctx, node)
	if (!unit) return ["unit_unbound", `${row.fact_id} has unit "${row.unit}" but no recognizable adjacent unit or column header`]
	return unitKey(unit) === unitKey(row.unit) ? null : ["unit_mismatch", `value-mode ${row.fact_id} is followed by or headed with "${unit}", but its row is in "${row.unit}"`]
}
