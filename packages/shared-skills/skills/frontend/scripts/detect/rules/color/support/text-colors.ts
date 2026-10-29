import { blend, parseColor, WHITE, type Rgba } from "../../../core/color"
import { ancestors, isRendered, styleOf } from "../../../core/page"
import type { ElementSnapshot, PageSnapshot } from "../../../types"
import { effectiveOpacity, gradientStops } from "./gradients"

export const clipsText = (el: ElementSnapshot): boolean =>
	[styleOf(el, "background-clip"), styleOf(el, "-webkit-background-clip")].some((v) => v.split(",").some((s) => s.trim() === "text"))

export function textInk(snapshot: PageSnapshot, el: ElementSnapshot): Rgba | null {
	if (!isRendered(snapshot, el) || !/[\p{L}\p{N}]/u.test(el.ownText)) return null
	if (["script", "style", "title", "option", "noscript", "template"].includes(el.tag)) return null
	const fill = styleOf(el, "-webkit-text-fill-color")
	const color = parseColor(fill || styleOf(el, "color"))
	if (!color || color.a <= 0.02) return null
	return { ...color, a: color.a * effectiveOpacity(snapshot, el) }
}

export function textBackgrounds(snapshot: PageSnapshot, el: ElementSnapshot): readonly Rgba[] {
	const layers: Rgba[] = []
	for (const node of [el, ...ancestors(snapshot, el)]) {
		const image = styleOf(node, "background-image")
		if (image.includes("url(")) return []
		if (image.includes("gradient") && !clipsText(node)) {
			const ground = solidGround(snapshot, node)
			const stops = gradientStops(image)
			return stops.map((s) => layers.reduceRight((under, top) => blend(top, under), blend(s.color, ground)))
		}
		const fill = parseColor(styleOf(node, "background-color"))
		if (fill && fill.a > 0) {
			layers.push(fill)
			if (fill.a >= 1) break
		}
	}
	return [layers.reduceRight((under, top) => blend(top, under), WHITE)]
}

export function solidGround(snapshot: PageSnapshot, el: ElementSnapshot): Rgba {
	const layers: Rgba[] = []
	for (const node of [el, ...ancestors(snapshot, el)]) {
		const c = parseColor(styleOf(node, "background-color"))
		if (c) {
			layers.push(c)
			if (c.a >= 1) break
		}
	}
	return layers.reduceRight((under, top) => blend(top, under), WHITE)
}
