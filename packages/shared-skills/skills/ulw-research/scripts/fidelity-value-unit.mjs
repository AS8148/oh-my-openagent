// Value-mode units live outside the fact element. The documented form is the value then its unit,
// with or without a space, a Korean particle allowed after it ({{F1:span:value}} m, {{F3:rate:value}}%,
// {{F21:rev:value}}\uC5B5 \uC6D0\uC73C\uB85C); a currency sign right before the value; the :unit element
// right after it; or the same visual column's table header. Unknown words are advisory, never guessed units.
import { cellsOf, rowsOf } from "./fact-locate.mjs"
import { unitKey } from "./fidelity-binding.mjs"
import { proseText } from "./html-lite.mjs"
import { dimensionOf, normalizeUnit, spacedAliasUnit } from "./units.mjs"

// Korean particles a unit may carry (eun/neun, i/ga, eul/reul, ui, e, eseo, ege, euro/ro, wa/gwa, do, man,
// kkaji, buteo, boda, ssik, in, ida/yeotda/ieotda, imyeo, igo), longest first.
const PARTICLES = ["\uC774\uC5C8\uB2E4", "\uC600\uB2E4", "\uC774\uB2E4", "\uC774\uBA70", "\uC774\uACE0", "\uC73C\uB85C", "\uC5D0\uC11C", "\uC5D0\uAC8C", "\uAE4C\uC9C0", "\uBD80\uD130", "\uBCF4\uB2E4", "\uC740", "\uB294", "\uC774", "\uAC00", "\uC744", "\uB97C", "\uC758", "\uC5D0", "\uB85C", "\uC640", "\uACFC", "\uB3C4", "\uB9CC", "\uC529", "\uC778"]
const SIGNS = ["US$", "$", "\u20AC", "\u20A9", "\u00A3", "\u00A5"]

const withoutParticle = (word) => {
	const particle = PARTICLES.find((p) => word.endsWith(p) && word.length > p.length)
	return particle ? word.slice(0, -particle.length) : word
}
const unitOf = (word) => normalizeUnit(word) ?? normalizeUnit(withoutParticle(word))
const scaleOf = (unit) => /-(e\d+)$/.exec(unit ?? "")?.[1] ?? null

/** The unit written right after the value: the row's own unit (even across words), a spaced alias, or the next word. */
function unitAfter(text, row) {
	const clause = text.replace(/^[\s\u00A0]+/u, "").split(/[,.;:!?()[\]"]/u)[0]
	const words = clause.split(/[\s\u00A0]+/u).filter(Boolean).slice(0, 3)
	if (words.length === 0) return null
	for (let n = words.length; n > 0; n--) {
		const unit = unitOf(words.slice(0, n).join(""))
		if (unit && unitKey(unit) === unitKey(row.unit)) return { token: unit }
	}
	for (let n = words.length; n > 1; n--) {
		const spaced = [...words.slice(0, n - 1), withoutParticle(words[n - 1])].join(" ")
		const unit = spacedAliasUnit(spaced)
		if (unit) return { token: unit }
	}
	const first = unitOf(words[0])
	if (!first) return null
	const currency = words[1] ? unitOf(words[1]) : null
	if (dimensionOf(first) === "scale" && dimensionOf(currency)?.startsWith("currency:")) return { token: `${currency} ${words[0]}`, dimension: dimensionOf(currency), scale: first }
	return { token: first }
}

function signBefore(text) {
	const trimmed = text.replace(/[\s\u00A0]+$/u, "")
	const sign = SIGNS.find((s) => trimmed.endsWith(s))
	return sign ? { token: normalizeUnit(sign) } : null
}

function agrees(found, row) {
	if (found.scale) return dimensionOf(row.unit) === found.dimension && scaleOf(row.unit) === found.scale
	if (unitKey(found.token) === unitKey(row.unit)) return true
	if (dimensionOf(found.token) === "scale") return scaleOf(row.unit) === found.token
	if (dimensionOf(found.token)?.startsWith("currency:") && found.sign) return dimensionOf(row.unit) === dimensionOf(found.token)
	return unitKey(found.token) === unitKey(row.unit)
}

/** The header of the cell's visual column; nothing binds in a table with a rowspan or without a th row. */
function headerUnit(ctx, node) {
	const cell = ctx.util.closest(node, (cur) => cur.tag === "td")
	const table = cell && ctx.util.closest(cell, (cur) => cur.tag === "table")
	if (!table || cell.attrs.colspan || cell.attrs.rowspan) return null
	const rows = rowsOf(table)
	if (rows.some((row) => row.children.some((cur) => cur.attrs?.rowspan && cur.attrs.rowspan !== "1"))) return null
	const header = rows.find((row) => row.children.some((cur) => cur.tag === "th"))
	if (!header || header === cell.parent) return null
	const head = cellsOf(header)[cellsOf(cell.parent).indexOf(cell)]
	if (!head) return null
	const text = proseText(head)
	const label = (/\(([^()]+)\)\s*$/u.exec(text)?.[1] ?? text).trim()
	const unit = unitOf(label) ?? unitOf(label.split(/\s+/u).at(-1) ?? "")
	return unit ? { token: unit } : null
}

/** The documented split form: the next element is this fact's own :unit element. */
function unitElementAfter(siblings, at, row) {
	const next = siblings.slice(at + 1).find((cur) => !(cur.tag === "#text" && !cur.text.trim()))
	return next?.attrs?.["data-fact"] === row.fact_id && unitKey(proseText(next)) === unitKey(row.unit)
}

/** A mode marker written by fill distinguishes value-only output from full/unit modes. */
export function valueUnitProblem(ctx, node, row) {
	if (node.attrs["data-fact-mode"] !== "value" || !unitKey(row.unit)) return null
	const siblings = node.parent.children
	const at = siblings.indexOf(node)
	const shown = proseText(node)
	const [prev, next] = [siblings[at - 1], siblings[at + 1]]
	const sign = signBefore(`${prev?.tag === "#text" ? prev.text : ""}${shown.replace(/\d[\s\S]*$/u, "")}`)
	const following = `${shown.replace(/^[\s\S]*\d/u, "")}${next?.tag === "#text" ? next.text : ""}`
	const after = unitAfter(following, row) ?? (unitElementAfter(siblings, at, row) ? { token: row.unit } : null)
	const found = [["preceded by", sign && { ...sign, sign: true }], ["followed by", after], ["headed with", headerUnit(ctx, node)]].filter(([, unit]) => unit)
	if (found.length === 0) return ["unit_unbound", `${row.fact_id} has unit "${row.unit}" but no recognizable unit right after its value, before it as a currency sign, or in its column header`]
	const wrong = found.find(([, unit]) => !agrees(unit, row))
	return wrong ? ["unit_mismatch", `value-mode ${row.fact_id} is ${wrong[0]} "${wrong[1].token}", but its row is in "${row.unit}"`] : null
}
