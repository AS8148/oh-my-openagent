// html-visible.mjs - the rendered-markup projection: what a reader can actually see.
//
// hiddenRegions(html) lists, in order, every region a reader cannot see as {start, end, markup}:
// comments and <!...>/<?...> declarations; HIDDEN_ELEMENT_TAGS elements; and any element (with its
// descendants) that carries the hidden attribute or an inline style with display:none,
// visibility:hidden|collapse, font-size:0 or opacity:0. aria-hidden is not visual hiding (browsers
// render it), so it never hides. An element that never closes is hidden to the end of the input:
// that fails closed for presence (everything after it counts as absent) and, because callers
// compare each region's raw markup byte for byte, for edits inside it too. Stylesheet rules are not
// resolved. visibleMarkup(html) replaces each region with one space. markedVisibility(html, names)
// gives each opening tag carrying one of the named attributes as "name=value visible|hidden".
// elementSpans(html, accept) finds whole elements by tag scan (nesting and quoted ">" handled).
// tagAttributes(html) lists each opening tag's attributes in order, comments skipped, parsed by
// html-lite's attribute reader (double, single or no quotes). Plain Node ESM, no dependencies.

import { readTag } from "./html-lite.mjs"

/** Elements whose content never renders in the report body. */
export const HIDDEN_ELEMENT_TAGS = Object.freeze(["head", "script", "style", "template", "noscript"])
const HIDDEN = new Set(HIDDEN_ELEMENT_TAGS)
const RAW = new Set(["script", "style"])
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"])
const ZERO = /^\+?(?:0+(?:\.0*)?|\.0+)[a-z%]*$/
const isLetter = (ch) => (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z")

/** True when an element with this tag name and these attributes renders nothing. */
export function isHiddenElement(name, attrs) {
	if (HIDDEN.has(name) || Object.hasOwn(attrs, "hidden")) return true
	for (const declaration of (attrs.style ?? "").split(";")) {
		const colon = declaration.indexOf(":")
		if (colon === -1) continue
		const property = declaration.slice(0, colon).trim().toLowerCase()
		const value = declaration.slice(colon + 1).replace(/!important/i, "").trim().toLowerCase()
		if (property === "display" && value === "none") return true
		if (property === "visibility" && (value === "hidden" || value === "collapse")) return true
		if ((property === "font-size" || property === "opacity") && ZERO.test(value)) return true
	}
	return false
}

/**
 * Walk tags from `at`: visit(kind, start, end, tag) with kind "skip" (comment, declaration),
 * "open" or "close". visit may return a later offset to resume from, or Infinity to stop.
 */
function scan(src, at, visit) {
	while (at < src.length) {
		const lt = src.indexOf("<", at)
		if (lt === -1) return
		const next = src[lt + 1] ?? ""
		let end
		let resume
		if (src.startsWith("<!--", lt) || next === "!" || next === "?") {
			const comment = src.startsWith("<!--", lt)
			const close = src.indexOf(comment ? "-->" : ">", lt + (comment ? 4 : 1))
			end = close === -1 ? src.length : close + (comment ? 3 : 1)
			resume = visit("skip", lt, end, null)
		} else if (next === "/" && isLetter(src[lt + 2] ?? "")) {
			const tag = readTag(src, lt + 2)
			end = tag.end
			resume = visit("close", lt, end, tag)
		} else if (isLetter(next)) {
			const tag = readTag(src, lt + 1)
			end = tag.end
			resume = visit("open", lt, end, tag)
		} else end = lt + 1
		if (resume === Infinity) return
		at = resume ?? end
	}
}

/** The end offset of the element named `name` whose opening tag ends at `from` (input end if unclosed). */
function closeOf(src, from, name) {
	if (RAW.has(name)) {
		const close = src.toLowerCase().indexOf(`</${name}`, from)
		const gt = close === -1 ? -1 : src.indexOf(">", close)
		return gt === -1 ? src.length : gt + 1
	}
	let depth = 0
	let stop = src.length
	scan(src, from, (kind, _start, end, tag) => {
		if (tag?.name !== name || (kind === "open" && tag.selfClosing)) return undefined
		if (kind === "open") depth++
		else if (depth === 0) {
			stop = end
			return Infinity
		} else depth--
		return undefined
	})
	return stop
}

const endOf = (src, end, tag) => (tag.selfClosing || VOID.has(tag.name) ? end : closeOf(src, end, tag.name))

/** Every region a reader cannot see, in document order, as {start, end, markup}. */
export function hiddenRegions(html) {
	const src = String(html)
	const regions = []
	const add = (start, end) => {
		regions.push({ start, end, markup: src.slice(start, end) })
		return end
	}
	scan(src, 0, (kind, start, end, tag) => {
		if (kind === "skip") return add(start, end)
		if (kind !== "open" || !isHiddenElement(tag.name, tag.attrs)) return undefined
		return add(start, endOf(src, end, tag))
	})
	return regions
}

/** The markup with every region a reader cannot see replaced by one space. */
export function visibleMarkup(html) {
	const src = String(html)
	let out = ""
	let kept = 0
	for (const { start, end } of hiddenRegions(src)) {
		out += `${src.slice(kept, start)} `
		kept = end
	}
	return out + src.slice(kept)
}

/** "attribute=value visible|hidden" for each opening tag carrying one of `names`, in order. */
export function markedVisibility(html, names) {
	const src = String(html)
	const regions = hiddenRegions(src)
	const marks = []
	scan(src, 0, (kind, start, _end, tag) => {
		if (kind !== "open") return undefined
		const hidden = regions.some((region) => region.start <= start && start < region.end)
		for (const name of names) if (Object.hasOwn(tag.attrs, name)) marks.push(`${name}=${tag.attrs[name]} ${hidden ? "hidden" : "visible"}`)
		return undefined
	})
	return marks
}

/** Whole elements whose opening tag passes accept(name, attrs), as {start, end, tag}; nested matches skipped. */
export function elementSpans(html, accept) {
	const src = String(html)
	const spans = []
	scan(src, 0, (kind, start, end, tag) => {
		if (kind !== "open" || !accept(tag.name, tag.attrs)) return undefined
		const stop = endOf(src, end, tag)
		spans.push({ start, end: stop, tag })
		return stop
	})
	return spans
}

/** Each opening tag's {name, attrs} in document order; comments and declarations are skipped. */
export function tagAttributes(html) {
	const tags = []
	scan(String(html), 0, (kind, _start, _end, tag) => {
		if (kind === "open") tags.push({ name: tag.name, attrs: tag.attrs })
		return undefined
	})
	return tags
}
