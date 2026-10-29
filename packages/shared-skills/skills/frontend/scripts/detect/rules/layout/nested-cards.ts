import { ancestors, descendants, shortSnippet, styleOf } from "../../core/page"
import type { PageRule } from "../../rule"
import { cardLike, controlStrip, dialogCard, embeddedFrame, fieldBox, hasBorderOrShadow, labelBox, pageFrame, sharesEdges } from "./support/cards"
import { hasRole, ident, outOfFlow, painted } from "./support/geometry"

export const nestedCards: PageRule = {
	meta: {
		id: "nested-cards", name: "Nested cards", category: "slop", severity: "warning", engine: "page",
		description: "A bordered or raised card sits inside another card and adds an unnecessary surface.",
		fixHint: "Flatten the inner group with spacing, typography, or a divider instead of another card frame.",
	},
	check: ({ snapshot }) => {
		const candidates = snapshot.elements.filter((el) => {
			if (!painted(snapshot, el) || !cardLike(snapshot, el) || !hasBorderOrShadow(el) || outOfFlow(el) ||
				hasRole(el, ["menu", "listbox", "tablist", "radiogroup", "toolbar"]) ||
				/(?:^|[\s_-])(?:popover|dropdown|tooltip)(?:$|[\s_-])/.test(ident(el)) ||
				el.text.length < 10 || el.rect.width < 50 || el.rect.height < 30 ||
				/^(inline|contents)$/.test(styleOf(el, "display")) || labelBox(snapshot, el) || fieldBox(snapshot, el) || controlStrip(snapshot, el)) return false
			const outer = [...ancestors(snapshot, el)].find((a) => cardLike(snapshot, a) && !pageFrame(snapshot, a))
			return outer !== undefined && !sharesEdges(snapshot, el, outer) && !dialogCard(snapshot, outer) && !embeddedFrame(snapshot, el, outer)
		})
		return candidates.filter((el) => ![...descendants(snapshot, el)].some((d) => candidates.includes(d)))
			.map((el) => ({ element: el, message: "A separately framed card is nested inside another card.", snippet: shortSnippet(el) }))
	},
}
