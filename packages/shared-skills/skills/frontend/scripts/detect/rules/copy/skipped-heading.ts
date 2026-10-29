import { headingLevel } from "../../core/page"
import type { PageHit, PageRule } from "../../rule"
import { displayed, lineage } from "./support/page-text"

export const skippedHeading: PageRule = {
	meta: {
		id: "skipped-heading", name: "Skipped heading level", category: "quality", severity: "warning", engine: "page",
		description: "A heading jumps over a level in the visible content outline.",
		fixHint: "Use the next heading level and style it independently of its semantic rank.",
	},
	check: ({ snapshot }) => {
		const hits: PageHit[] = []
		let previous = 0
		let previousText = ""
		let previousFooter: number | undefined
		let previousOpensFooter = false
		for (const el of snapshot.elements) {
			const level = headingLevel(el)
			if (level === null || !displayed(snapshot, el) || el.rect.width <= 0 || el.rect.height <= 0) continue
			const path = lineage(snapshot, el)
			if (path.some((a) => a.style["visibility"] === "hidden" || (a.tag === "dialog" && a.attributes["open"] === undefined))) continue
			const footer = path.find((a) => a.tag === "footer" || a.attributes["role"] === "contentinfo" || a.attributes["id"] === "footer")?.index
			const opensFooter = footer !== undefined && footer !== previousFooter
			const intoFooter = footer !== undefined && (opensFooter || previousOpensFooter)
			const skips = previous > 0 && level > previous + 1
			if (skips && !intoFooter) hits.push({
				element: el, message: `h${previous} followed by h${level}; missing h${previous + 1}`,
				snippet: `${previousText.slice(0, 60)} / ${el.text.slice(0, 60)}`,
			})
			previousOpensFooter = opensFooter && previous > 0 && !skips
			previousFooter = footer
			previous = level
			previousText = el.text
		}
		return hits
	},
}
