import { ancestors, descendants, shortSnippet, styleOf } from "../../core/page"
import type { PageRule } from "../../rule"
import { alpha, borders, length, painted, right, scrollsX } from "./support/geometry"

export const edgeFlushCards: PageRule = {
	meta: {
		id: "edge-flush-cards", name: "Cards flush against the scroller edge", category: "quality", severity: "warning", engine: "page",
		description: "A card row keeps a gutter on one side but touches or slightly crosses the opposite clipping edge.",
		fixHint: "Size each panel to its scroll container and keep an equal inset at both edges.",
	},
	check: ({ snapshot }) => snapshot.elements.flatMap((scroller) => {
		if (scroller.tag === "body" || !scrollsX(scroller) || !painted(snapshot, scroller) ||
			scroller.scroll.scrollWidth <= scroller.scroll.clientWidth + 8 ||
			scroller.rect.width < 120 || scroller.rect.height < 60 || scroller.rect.y > snapshot.viewport.height * 2) return []
		const cards = [...descendants(snapshot, scroller)].filter((el) => {
			if (!painted(snapshot, el) || el.rect.width < 80 || el.rect.height < 40 ||
				/^(table|thead|tbody|tfoot|tr|td|th|col|colgroup)$/.test(el.tag) ||
				/^(row|cell|gridcell|rowgroup|columnheader|rowheader)$/.test(el.attributes["role"] ?? "")) return false
			if (alpha(el, "background-color") <= 0.5 && borders(el).filter(Boolean).length < 2) return false
			for (const a of ancestors(snapshot, el)) {
				if (a === scroller) return true
				if (scrollsX(a)) return false
			}
			return false
		})
		if (cards.length < 2 || Math.min(...cards.map((c) => right(c.rect))) > Math.max(...cards.map((c) => c.rect.x)) + 1) return []
		const left = scroller.rect.x + length(scroller, "border-left-width")
		const end = left + scroller.scroll.clientWidth
		const gutter = (side: "left" | "right"): boolean => {
			const inset = side === "left" ? scroller.rect.x : snapshot.document.clientWidth - right(scroller.rect)
			return inset >= 8 && alpha(scroller, "background-color") <= 0.05 &&
				length(scroller, `border-${side}-width`) === 0 && styleOf(scroller, "background-image") === "none"
		}
		const flush = cards.filter((c) => {
			const start = c.rect.x - left
			const gap = end - right(c.rect)
			return (start >= 6 && gap < 8 && gap > -24 && !(gap >= 0 && gutter("right"))) ||
				(gap >= 6 && start < 8 && start > -24 && !(start >= 0 && gutter("left")))
		})
		return flush.length === 0 ? [] : [{ element: scroller, message: `${flush.length} cards touch a scroll edge while keeping an opposite gutter.`, snippet: shortSnippet(scroller) }]
	}),
}
