import { childrenOf, descendants, fontSizePx, isHeading, parentOf, styleOf } from "../../../core/page"
import type { ElementSnapshot, PageSnapshot } from "../../../types"
import { cardLike, fillDiffers } from "./cards"
import { borders, bottom, chain, length, outOfFlow, painted, right, textLines } from "./geometry"

const separates = (s: PageSnapshot, el: ElementSnapshot): boolean =>
	borders(el).some(Boolean) || fillDiffers(s, el) || !["", "none"].includes(styleOf(el, "box-shadow"))
const spacer = (s: PageSnapshot, el: ElementSnapshot): boolean =>
	el.text === "" && !separates(s, el) && ![el, ...descendants(s, el)].some((n) =>
		/^(img|video|canvas|iframe|svg|input|button)$/.test(n.tag) || n !== el && separates(s, n))

export const flow = (s: PageSnapshot, el: ElementSnapshot): boolean =>
	painted(s, el) && !outOfFlow(el) && !["inline", "none"].includes(styleOf(el, "display"))

function flowBoxes(s: PageSnapshot, el: ElementSnapshot, heading: ElementSnapshot): readonly ElementSnapshot[] {
	if (styleOf(el, "display") === "contents") return childrenOf(s, el).flatMap((c) => flowBoxes(s, c, heading))
	if (!flow(s, el) || spacer(s, el)) return []
	if (Math.min(right(el.rect), right(heading.rect)) - Math.max(el.rect.x, heading.rect.x) < Math.min(el.rect.width, heading.rect.width) * 0.3) return []
	return [el]
}

export function neighbour(s: PageSnapshot, heading: ElementSnapshot, before: boolean, start = heading): ElementSnapshot | null {
	let cursor = start
	for (let depth = 0; depth < 20; depth++) {
		const parent = parentOf(s, cursor)
		if (!parent) return null
		const siblings = childrenOf(s, parent)
		if (!before && cursor !== heading && siblings.filter((n) => n.tag === cursor.tag && n.attributes["class"] === cursor.attributes["class"])
			.some((n) => n !== cursor && childrenOf(s, n).map((c) => c.tag).join(",") === childrenOf(s, cursor).map((c) => c.tag).join(","))) return null
		const i = siblings.indexOf(cursor)
		const choices = (before ? siblings.slice(0, i) : siblings.slice(i + 1))
			.flatMap((n) => flowBoxes(s, n, heading))
			.filter((n) => before ? bottom(n.rect) <= start.rect.y + 2 : n.rect.y >= bottom(heading.rect) - 2)
			.sort((a, b) => before ? bottom(b.rect) - bottom(a.rect) : a.rect.y - b.rect.y)
		const found = choices[0]
		if (found) return found
		if (parent.tag === "body" || separates(s, parent) || !before && (parent.tag === "main" || parent.attributes["role"] === "main")) return null
		cursor = parent
	}
	return null
}

export function headingCluster(s: PageSnapshot, heading: ElementSnapshot, below: number): ElementSnapshot {
	let top = heading
	for (let count = 0; count < 3; count++) {
		const previous = neighbour(s, heading, true, top)
		if (!previous || isHeading(previous) || previous.text.length === 0 || previous.text.length > 80 || previous.rect.height > 60) break
		const gap = top.rect.y - bottom(previous.rect)
		const words = [previous, ...descendants(s, previous)].filter((n) => n.ownText !== "")
		const word = words[0] ?? previous
		const p = parentOf(s, word)
		const opens = p !== null && childrenOf(s, p).filter((n) => !spacer(s, n))[0] === word
		const lines = words.flatMap((n) => textLines(s, n))
		const label = fontSizePx(word) <= 14 || styleOf(word, "text-transform") === "uppercase" ||
			length(word, "letter-spacing") >= fontSizePx(word) * 0.05 || opens &&
			(styleOf(word, "font-style") === "italic" || Number.parseFloat(styleOf(word, "font-weight")) < 400 ||
				styleOf(word, "color") !== styleOf(heading, "color"))
		const subtitle = opens && gap <= 2 && fontSizePx(word) <= fontSizePx(heading) && lines.length <= 1
		if (gap < 0 || gap >= 28 && !(opens && gap < below && gap <= 64) || !(label || subtitle) || lines.length > 1) break
		top = previous
	}
	return top
}

export function rhythmExempt(s: PageSnapshot, el: ElementSnapshot): boolean {
	if (!flow(s, el) || el.text.length < 3 || !["h2", "h3", "h4"].includes(el.tag) || borders(el)[0]) return true
	return chain(s, el).some((a) => ["blockquote", "q", "nav", "footer"].includes(a.tag) ||
		a !== el && cardLike(s, a) && a.rect.height < 200)
}

export function closesInProse(s: PageSnapshot, el: ElementSnapshot): boolean {
	const blocks = [el, ...descendants(s, el)].filter((n) => ["p", "li", "dd", "div"].includes(n.tag) && n.ownText !== "" && flow(s, n))
	const last = blocks.sort((a, b) => bottom(b.rect) - bottom(a.rect))[0]
	return last !== undefined && textLines(s, last).length >= 2 && fontSizePx(last) < 28
}

export const separatesBelow = (s: PageSnapshot, el: ElementSnapshot): boolean =>
	el.tag === "hr" || ["img", "video", "canvas", "svg"].includes(el.tag) ||
	(borders(el)[2] === true || fillDiffers(s, el) || !["", "none"].includes(styleOf(el, "box-shadow"))) &&
		borders(el).filter(Boolean).length < 3 && !["pre", "code"].includes(el.tag)
