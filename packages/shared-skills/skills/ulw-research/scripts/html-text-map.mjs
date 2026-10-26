// html-text-map.mjs - the reader-visible text of a page, with a source map back into the markup.
//
// extractHtml(html) returns { root, text, blocks, starts, ends }: `text` is one line per block
// (prose blocks and table cells; whitespace collapsed, entities decoded) and text unit k came from
// html.slice(starts[k], ends[k]). Only text nodes are read: attribute values, CSS, scripts, and
// anything a reader never sees (head, script, style, svg, noscript, template, code-like elements,
// the hidden attribute, aria-hidden="true", display:none, visibility:hidden inline or by a <style> rule
// on a simple selector (.class, #id, tag), and their descendants)
// contribute nothing, so a locator over `text` can never land in markup. A synthetic separator
// (collapsed break, line feed) maps to an empty range at the previous character's end.
// Plain Node ESM, sibling imports only.

import { decodeOne } from "./entities.mjs"
import { parseHtml, PROSE_BREAKS, PROSE_TAGS } from "./html-lite.mjs"

const SKIP = new Set(["head", "script", "style", "svg", "code", "pre", "kbd", "samp", "template", "noscript"])
const INLINE = new Set([
	"a", "abbr", "b", "bdi", "bdo", "cite", "data", "del", "dfn", "em", "font", "i", "ins", "label", "mark", "q", "s",
	"small", "span", "strong", "sub", "sup", "time", "u", "var",
])
const HIDDEN_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!important\s*)?(?:;|$)/i
const SPACE = /\s/

/** Simple selectors (.class, #id, tag) that <style> blocks hide; compound or nested selectors are not read. */
export function hidingRules(root) {
	const rules = new Set()
	const visit = (node) => {
		if (node.tag === "style") {
			for (const [, selectors, body] of String(node.raw ?? "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
				if (!HIDDEN_STYLE.test(body.trim())) continue
				for (const selector of selectors.split(",").map((part) => part.trim())) if (/^(?:[.#][\w-]+|[a-z][a-z0-9]*)$/i.test(selector)) rules.add(selector.toLowerCase())
			}
		}
		for (const child of node.children ?? []) visit(child)
	}
	visit(root)
	return rules
}

/** Whether a reader never sees the element or anything inside it (rules: hidingRules of its document). */
export function hiddenElement(node, rules = new Set()) {
	if (SKIP.has(node.tag)) return true
	const attrs = node.attrs ?? {}
	if (attrs.hidden !== undefined || String(attrs["aria-hidden"] ?? "").trim().toLowerCase() === "true" || HIDDEN_STYLE.test(attrs.style ?? "")) return true
	const names = [node.tag, attrs.id && `#${attrs.id}`, ...String(attrs.class ?? "").split(/\s+/).filter(Boolean).map((name) => `.${name}`)]
	return names.some((name) => name && rules.has(name.toLowerCase()))
}

function newLine() {
	return { node: null, text: "", starts: [], ends: [], space: null }
}

function put(line, unit, start, end) {
	if (SPACE.test(unit)) {
		if (line.text !== "" && line.space === null) line.space = [start, end]
		return
	}
	if (line.space !== null) {
		line.text += " "
		line.starts.push(line.space[0])
		line.ends.push(line.space[1])
		line.space = null
	}
	line.text += unit
	line.starts.push(start)
	line.ends.push(end)
}

/** A collapsible break with no source character of its own. */
function softBreak(line) {
	if (line.text !== "" && line.space === null) {
		const at = line.ends[line.ends.length - 1]
		line.space = [at, at]
	}
}

/** Append a text node's source range, decoding entities exactly as decodeEntities does. */
function putText(line, src, from, to) {
	for (let at = from; at < to; ) {
		if (src[at] === "&") {
			const semi = src.indexOf(";", at + 1)
			const decoded = semi !== -1 && semi < to && semi - at <= 12 ? decodeOne(src.slice(at + 1, semi)) : null
			if (decoded !== null) {
				for (let k = 0; k < decoded.length; k++) put(line, decoded[k], at, semi + 1)
				at = semi + 1
				continue
			}
		}
		put(line, src[at], at, at + 1)
		at++
	}
}

function putProse(line, src, node, rules) {
	for (const child of node.children) {
		if (child.tag === "#text") putText(line, src, child.source_start, child.source_end)
		else if (!hiddenElement(child, rules)) {
			const breaks = PROSE_BREAKS.has(child.tag)
			if (breaks) softBreak(line)
			putProse(line, src, child, rules)
			if (breaks) softBreak(line)
		}
	}
}

/** See the file comment. blocks: [{ node, start, end }] with text.slice(start, end) one block line. */
export function extractHtml(html) {
	const src = String(html)
	const root = parseHtml(src)
	const rules = hidingRules(root)
	const lines = []
	let line = newLine()
	const flush = (node) => {
		if (line.text !== "") lines.push({ ...line, node })
		line = newLine()
	}
	const walk = (node) => {
		for (const child of node.children) {
			if (child.tag === "#text") putText(line, src, child.source_start, child.source_end)
			else if (hiddenElement(child, rules)) continue
			else if (child.tag === "br") flush(node)
			else if (INLINE.has(child.tag)) walk(child)
			else if (PROSE_TAGS.has(child.tag)) {
				flush(node)
				putProse(line, src, child, rules)
				flush(child)
			} else {
				flush(node)
				walk(child)
				flush(child)
			}
		}
	}
	walk(root)
	flush(root)
	const blocks = []
	const starts = []
	const ends = []
	let text = ""
	for (const entry of lines) {
		if (text !== "") {
			const at = ends[ends.length - 1]
			text += "\n"
			starts.push(at)
			ends.push(at)
		}
		blocks.push({ node: entry.node, start: text.length, end: text.length + entry.text.length })
		text += entry.text
		starts.push(...entry.starts)
		ends.push(...entry.ends)
	}
	return { root, text, blocks, starts, ends }
}
