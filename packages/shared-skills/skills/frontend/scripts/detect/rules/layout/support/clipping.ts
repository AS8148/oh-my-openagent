import { ancestors, childrenOf, descendants, styleOf } from "../../../core/page"
import type { ElementSnapshot, PageSnapshot } from "../../../types"
import { bottom, chain, hasRole, ident, outOfFlow, painted, right, scrollsX } from "./geometry"

export const viewportTrack = (el: ElementSnapshot): boolean =>
	/(?:^|[\s_-])(?:carousel|slider|swiper|marquee|ticker|fisheye|track|scroller)(?:$|[\s_-])/.test(ident(el)) ||
	/carousel/i.test(el.attributes["aria-roledescription"] ?? "")

export const shell = (s: PageSnapshot, el: ElementSnapshot): boolean =>
	el.tag === "body" || el.rect.x <= 1 && el.rect.y <= 1 && el.rect.width >= s.viewport.width * 0.98 && el.rect.height >= s.document.scrollHeight * 0.98

export function clippedAxes(el: ElementSnapshot): readonly [boolean, boolean] | null {
	if (["contents", "none"].includes(styleOf(el, "display")) || el.rect.width <= 0 || el.rect.height <= 0 ||
		scrollsX(el) || /^(auto|scroll)$/.test(styleOf(el, "overflow-y"))) return null
	const x = /^(hidden|clip)$/.test(styleOf(el, "overflow-x"))
	const y = /^(hidden|clip)$/.test(styleOf(el, "overflow-y"))
	return x || y ? [x, y] : null
}

export function traps(s: PageSnapshot, clip: ElementSnapshot, el: ElementSnapshot): boolean {
	const axes = clippedAxes(clip)
	if (!axes) return false
	const parents = [...ancestors(s, el)]
	const between = parents.slice(0, parents.indexOf(clip) + 1)
	if (styleOf(el, "position") === "fixed" && !between.some((n) =>
		!["", "none"].includes(styleOf(n, "transform")) || /paint|layout|strict|content/.test(styleOf(n, "contain")) ||
		!["", "none"].includes(styleOf(n, "filter")))) return false
	if (styleOf(el, "position") === "absolute") {
		const cb = parents.find((n) => styleOf(n, "position") !== "static" || !["", "none"].includes(styleOf(n, "transform")))
		if (cb && !between.includes(cb)) return false
	}
	return axes[0] && (el.rect.x < clip.rect.x - 2 || right(el.rect) > right(clip.rect) + 2) ||
		axes[1] && (el.rect.y < clip.rect.y - 2 || bottom(el.rect) > bottom(clip.rect) + 2)
}

export const popover = (el: ElementSnapshot): boolean =>
	hasRole(el, ["menu", "listbox", "tooltip", "dialog", "alertdialog", "tree"]) ||
	el.tag === "dialog" && el.attributes["open"] !== undefined || el.attributes["popover"] !== undefined ||
	/(?:^|[\s_-])(?:dropdown|popover|tooltip|flyout)(?:$|[\s_-])/.test(ident(el))

export function clippedChild(s: PageSnapshot, clip: ElementSnapshot): ElementSnapshot | undefined {
	if (!clippedAxes(clip) || shell(s, clip) || viewportTrack(clip) || childrenOf(s, clip).some(viewportTrack) || !painted(s, clip)) return undefined
	return [...descendants(s, clip)].find((el) => {
		if (!outOfFlow(el) || viewportTrack(el) || !(popover(el) || [...descendants(s, el)].some(popover))) return false
		if (!traps(s, clip, el)) return false
		const parents = [...ancestors(s, el)]
		const between = parents.slice(0, parents.indexOf(clip))
		if (between.some((n) => traps(s, n, el) || scrollsX(n) || /^(auto|scroll)$/.test(styleOf(n, "overflow-y")))) return false
		return chain(s, el).every((n) => styleOf(n, "display") !== "none" && styleOf(n, "visibility") !== "hidden" &&
			!(Number.parseFloat(styleOf(n, "opacity")) <= 0.01))
	})
}
