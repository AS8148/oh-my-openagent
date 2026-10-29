import { parseColor } from "../../core/color"
import { isRendered, shortSnippet, styleOf } from "../../core/page"
import type { PageRule } from "../../rule"
import type { ElementSnapshot, PageSnapshot } from "../../types"
import { effectiveOpacity, gradientStops, sameColor } from "./support/gradients"
import { clipsText } from "./support/text-colors"

function shimmer(snapshot: PageSnapshot, el: ElementSnapshot): boolean {
	const stops = gradientStops(styleOf(el, "background-image"))
	const first = stops[0]
	const last = stops.at(-1)
	const ink = parseColor(styleOf(el, "color"))
	if (!first || !last || !ink || stops.length < 3 || !sameColor(first.color, ink) || !sameColor(last.color, ink)) return false
	let plateau = 0
	for (let i = 1; i < stops.length; i++) {
		const a = stops[i - 1]
		const b = stops[i]
		if (a && b && a.position !== null && b.position !== null && sameColor(a.color, ink) && sameColor(b.color, ink)) plateau += b.position - a.position
	}
	if (plateau < 0.5 || Number.parseFloat(styleOf(el, "background-size")) <= 100 || !styleOf(el, "background-size").split(/\s+/)[0]?.endsWith("%")) return false
	if (styleOf(el, "animation-play-state") === "paused") return false
	return styleOf(el, "animation-iteration-count").includes("infinite") && styleOf(el, "animation-name").split(",").some((name) =>
		name.trim() !== "none" && snapshot.cssText.some((css) => {
			const start = css.indexOf(`@keyframes ${name.trim()}`)
			return start >= 0 && /background-position/.test(css.slice(start, css.indexOf("}}", start) + 2 || undefined))
		}))
}

export const gradientText: PageRule = {
	meta: {
		id: "gradient-text", name: "Gradient text", category: "slop", severity: "warning", engine: "page",
		description: "A color ramp clipped to text adds decoration to the glyphs.",
		fixHint: "Use a solid text color to keep the emphasis readable.",
	},
	check: ({ snapshot }) => snapshot.elements.flatMap((el) => {
		if (!isRendered(snapshot, el) || el.text.trim() === "" || !clipsText(el)) return []
		const image = styleOf(el, "background-image")
		const stops = gradientStops(image)
		const first = stops[0]
		if (!first || !image.includes("gradient") || stops.every((s) => sameColor(s.color, first.color))) return []
		if (Math.max(...stops.map((s) => s.color.a)) * effectiveOpacity(snapshot, el) < 0.15 || shimmer(snapshot, el)) return []
		return [{ element: el, message: "A gradient paints the text", snippet: shortSnippet(el) }]
	}),
}
