import { shortSnippet } from "../../core/page"
import type { PageRule } from "../../rule"
import { chain, painted, right, scrollsX } from "./support/geometry"

export const viewportReflow: PageRule = {
	meta: {
		id: "viewport-reflow", name: "Viewport reflow", category: "quality", severity: "error", engine: "page",
		description: "The document is wider than the viewport and requires sideways scrolling.",
		fixHint: "Constrain the widest content, allow long tokens to wrap, and keep intentional horizontal scrolling inside its own region.",
	},
	check: ({ snapshot }) => {
		if (snapshot.document.scrollWidth <= snapshot.document.clientWidth) return []
		const widest = snapshot.elements
			.filter((el) => painted(snapshot, el) && right(el.rect) > snapshot.document.clientWidth &&
				!chain(snapshot, el).slice(1).some(scrollsX))
			.sort((a, b) => right(b.rect) - right(a.rect))[0]
		return [{
			element: null,
			message: `Document width ${snapshot.document.scrollWidth}px exceeds ${snapshot.document.clientWidth}px${widest ? `; furthest element ${widest.selector} ends at ${right(widest.rect)}px` : ""}.`,
			snippet: widest ? shortSnippet(widest) : `${snapshot.document.scrollWidth}px / ${snapshot.document.clientWidth}px`,
		}]
	},
}
