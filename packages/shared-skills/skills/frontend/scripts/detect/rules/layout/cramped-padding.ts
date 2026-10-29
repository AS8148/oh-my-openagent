import { childrenOf, descendants, fontSizePx, shortSnippet, styleOf } from "../../core/page"
import type { PageRule } from "../../rule"
import { fillDiffers } from "./support/cards"
import { alpha, borders, bottom, bounds, chain, clipsY, length, outOfFlow, painted, right, textLines } from "./support/geometry"

export const crampedPadding: PageRule = {
	meta: {
		id: "cramped-padding", name: "Cramped padding", category: "quality", severity: "warning", engine: "page",
		description: "Rendered text sits too close to a visible container boundary.",
		fixHint: "Inset text from the painted boundary; use at least 8px beside body text and scale the space with its font size.",
	},
	check: ({ snapshot }) => snapshot.elements.flatMap((el) => {
		if (!painted(snapshot, el) || styleOf(el, "display") === "inline" || el.rect.width <= 0 || el.rect.height <= 0) return []
		const drawn = borders(el)
		const fill = fillDiffers(snapshot, el)
		const outline = length(el, "outline-width") > 0 && !["", "none"].includes(styleOf(el, "outline-style")) && alpha(el, "outline-color") > 0
		const fullBleed = el.rect.width >= snapshot.document.clientWidth * 0.94
		if (!fill && !drawn.some(Boolean) && !outline) return []
		const sides = ["top", "right", "bottom", "left"]
		const inset = (r: typeof el.rect): readonly number[] => [
			r.y - el.rect.y - length(el, "border-top-width"),
			right(el.rect) - right(r) - length(el, "border-right-width"),
			bottom(el.rect) - bottom(r) - length(el, "border-bottom-width"),
			r.x - el.rect.x - length(el, "border-left-width"),
		]
		if (el.ownText.length > 20 && el.rect.width > 100 && el.rect.height > 30 &&
			!(el.tag === "code" && !snapshot.elements.some((a) => a.tag === "pre" && [...descendants(snapshot, a)].includes(el)))) {
			const text = bounds(el.lineRects)
			if (!text) return []
			const insets = inset(text)
			const size = fontSizePx(el)
			const bad = sides.some((side, i) => {
				const vertical = i === 0 || i === 2
				const threshold = vertical ? Math.max(4, size * 0.3) : Math.max(8, size * 0.5)
				return (drawn[i] || fill && (vertical || !fullBleed)) &&
					length(el, `padding-${side}`) < threshold && (insets[i] ?? Infinity) < threshold
			})
			return bad ? [{ element: el, message: "The measured inset is too small for the text size.", snippet: shortSnippet(el) }] : []
		}
		if (el.ownText !== "" || outOfFlow(el) || /^(body|html|table|thead|tbody|tfoot|tr|td|th|ul|ol|dl|svg)$/.test(el.tag)) return []
		let kids = childrenOf(snapshot, el)
		let unwrapped = false
		for (let depth = 0; depth < 3; depth++) {
			const only = kids.length === 1 ? kids[0] : undefined
			if (!only || only.ownText !== "" || borders(only).some(Boolean) || fillDiffers(snapshot, only) ||
				["top", "right", "bottom", "left"].some((side) => length(only, `padding-${side}`) > 0) ||
				childrenOf(snapshot, only).length === 0) break
			kids = childrenOf(snapshot, only)
			unwrapped = true
		}
		const texts = [...descendants(snapshot, el)].filter((n) =>
			n.ownText.length > 4 && painted(snapshot, n) && !chain(snapshot, n).slice(0, chain(snapshot, n).indexOf(el)).some(outOfFlow))
		const flush = sides.some((side, i) => {
			if (!(drawn[i] || outline || fill && (!(i === 1 || i === 3) || !fullBleed))) return false
			if (length(el, `padding-${side}`) > 2) return false
			if (i === 2 && [...descendants(snapshot, el)].some((n) => clipsY(n) &&
				n.scroll.scrollHeight > n.scroll.clientHeight + 1 && Math.abs(bottom(n.rect) - bottom(el.rect)) <= 2)) return false
			const textFlush = texts.some((n) => {
				let r = bounds(textLines(snapshot, n))
				if (!r) return false
				if ((el.rect.height < 27.5 || !fill && !outline && drawn.filter(Boolean).length === 1) &&
					(i === 0 || i === 2) && r.height > fontSizePx(n)) {
					const trim = (r.height - fontSizePx(n)) / 2
					r = { ...r, y: r.y + trim, height: r.height - trim * 2 }
				}
				const gap = inset(r)[i] ?? Infinity
				return gap >= -1 && gap < 4
			})
			if (!textFlush) return false
			const insulated = (c: typeof el): boolean => {
				if (outOfFlow(c)) return true
				const gap = inset(c.rect)[i] ?? Infinity
				const offset = styleOf(c, "position") === "relative" &&
					["top", "right", "bottom", "left"].some((p) => length(c, p) !== 0) ||
					!["", "none"].includes(styleOf(c, "transform"))
				if (offset) return gap >= 4
				return gap < -1 || gap >= 4 || styleOf(c, "position") === "static" &&
					(length(c, `padding-${side}`) >= 4 || length(c, `margin-${side}`) >= 4)
			}
			return unwrapped || !kids.some(insulated)
		})
		return flush ? [{ element: el, message: "Child text lands flush against a painted container edge.", snippet: shortSnippet(el) }] : []
	}),
}
