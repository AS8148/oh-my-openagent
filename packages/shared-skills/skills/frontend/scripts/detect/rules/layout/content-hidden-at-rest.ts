import { childrenOf, styleOf } from "../../core/page"
import type { PageRule } from "../../rule"
import type { ElementSnapshot, PageSnapshot } from "../../types"
import { chain, hasRole, ident, right } from "./support/geometry"

function closed(s: PageSnapshot, el: ElementSnapshot): boolean {
	const controls = s.elements.filter((n) => (n.attributes["aria-controls"] ?? "").split(/\s+/).includes(el.attributes["id"] ?? "\u0000"))
	const selected = controls.some((n) => n.attributes["aria-selected"] === "true" || n.attributes["aria-expanded"] === "true")
	if (!selected && controls.some((n) => n.attributes["aria-selected"] === "false" || n.attributes["aria-expanded"] === "false")) return true
	if (!selected && (hasRole(el, ["dialog", "alertdialog", "tabpanel", "menu", "listbox", "tooltip"]) ||
		/(?:^|[\s_-])(?:offcanvas|off-canvas|drawer|modal|flyout|dropdown|tab-content|tab-pane|tabpanel)(?:$|[\s_-])/.test(ident(el)))) return true
	if (styleOf(el, "position") === "fixed" && (right(el.rect) <= 0 || el.rect.x >= s.viewport.width)) return true
	const p = el.parent === null ? undefined : s.elements[el.parent]
	const siblings = p ? childrenOf(s, p) : []
	const previous = siblings[siblings.indexOf(el) - 1]
	if (previous && (previous.attributes["aria-expanded"] === "false" ||
		childrenOf(s, previous).length === 1 && childrenOf(s, previous)[0]?.attributes["aria-expanded"] === "false")) return true
	return el.attributes["inert"] !== undefined || el.tag === "nav" || hasRole(el, ["navigation", "menubar"])
}

export const contentHiddenAtRest: PageRule = {
	meta: {
		id: "content-hidden-at-rest", name: "Content invisible at rest", category: "quality", severity: "error", engine: "page",
		description: "A large share of page text remains transparent or hidden instead of appearing as content.",
		fixHint: "Show content by default and enhance its entrance without making visibility depend on a reveal script.",
	},
	check: ({ snapshot }) => {
		let total = 0
		let hidden = 0
		for (const el of snapshot.elements) {
			if (el.ownText === "") continue
			const path = chain(snapshot, el)
			if (path.some((n) => /^(script|style|noscript|template|svg|title|option)$/.test(n.tag) ||
				n.attributes["hidden"] !== undefined || n.attributes["aria-hidden"] === "true" || styleOf(n, "display") === "none")) continue
			const invisible = path.filter((n) => Number.parseFloat(styleOf(n, "opacity")) <= 0.02 || /^(hidden|collapse)$/.test(styleOf(n, "visibility")))
			if (invisible.length > 0 && path.some((n) => closed(snapshot, n))) continue
			total += el.ownText.length
			if (invisible.length > 0) hidden += el.ownText.length
		}
		if (total < 200 || hidden < 150 || hidden / total <= 0.3) return []
		return [{ element: null, message: `${hidden} of ${total} characters (${Math.round(hidden / total * 100)}%) remain hidden.`, snippet: `${hidden}/${total} hidden characters` }]
	},
}
