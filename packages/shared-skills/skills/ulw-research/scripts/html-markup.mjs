// Byte-preserving HTML boundaries for polish. No CSS or visibility inference.
import { readTag } from "./html-lite.mjs"

const RAW = new Set(["script", "style"])
const FROZEN = new Set([...RAW, "template"])
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"])
const isLetter = (ch) => /[a-z]/i.test(ch ?? "")

function scan(src, at, visit) {
	while (at < src.length) {
		const start = src.indexOf("<", at)
		if (start === -1) return
		const next = src[start + 1]
		let kind
		let end
		let tag = null
		if (src.startsWith("<!--", start) || next === "!" || next === "?") {
			kind = "skip"
			const comment = src.startsWith("<!--", start)
			const stop = src.indexOf(comment ? "-->" : ">", start + (comment ? 4 : 1))
			end = stop === -1 ? src.length : stop + (comment ? 3 : 1)
		} else if (isLetter(next) || (next === "/" && isLetter(src[start + 2]))) {
			kind = next === "/" ? "close" : "open"
			tag = readTag(src, start + (kind === "close" ? 2 : 1))
			end = tag.end
		} else {
			at = start + 1
			continue
		}
		const resume = visit(kind, start, end, tag)
		if (resume === Infinity) return
		at = resume ?? (kind === "open" && RAW.has(tag.name) ? closeOf(src, end, tag.name) : end)
	}
}

function closeOf(src, from, name) {
	if (RAW.has(name)) {
		const close = new RegExp(`</${name}(?=[\\s/>])[^>]*>`, "gi")
		close.lastIndex = from
		const match = close.exec(src)
		return match ? match.index + match[0].length : src.length
	}
	let depth = 0
	let stop = src.length
	scan(src, from, (kind, _start, end, tag) => {
		if (tag?.name !== name) return undefined
		if (kind === "open") depth++
		else if (depth === 0) {
			stop = end
			return Infinity
		} else depth--
		return undefined
	})
	return stop
}

const endOf = (src, end, tag) => VOID.has(tag.name) ? end : closeOf(src, end, tag.name)

/** Raw markup sequence, corresponding text slots, and markup with frozen elements omitted. */
export function markupParts(html) {
	const src = String(html)
	const markup = []
	const text = []
	let source = ""
	let kept = 0
	scan(src, 0, (kind, start, end, tag) => {
		const frozen = kind === "open" && FROZEN.has(tag.name)
		const stop = frozen ? endOf(src, end, tag) : end
		text.push(src.slice(kept, start))
		markup.push(src.slice(start, stop))
		source += src.slice(kept, start) + (frozen || kind === "skip" ? " " : src.slice(start, stop))
		kept = stop
		return stop
	})
	text.push(src.slice(kept))
	source += src.slice(kept)
	return { markup, text, source }
}

/** Whole elements accepted by the caller; nested matches stay within the outer match. */
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

export function tagAttributes(html) {
	const tags = []
	scan(String(html), 0, (kind, _start, _end, tag) => {
		if (kind === "open") tags.push({ name: tag.name, attrs: tag.attrs })
		return undefined
	})
	return tags
}
