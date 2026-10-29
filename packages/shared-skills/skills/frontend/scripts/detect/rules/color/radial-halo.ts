import { luminance } from "../../core/color"
import { isRendered, shortSnippet, styleOf } from "../../core/page"
import type { PageRule } from "../../rule"
import { backdrop, gradientStops, splitLayers, spread } from "./support/gradients"

export const radialHalo: PageRule = {
	meta: {
		id: "radial-halo", name: "Radial-gradient background halo", category: "slop", severity: "warning", engine: "page",
		description: "A saturated radial fade decorates a dark surface with a halo.",
		fixHint: "Ground the section with a solid or subtly shifted background.",
	},
	check: ({ snapshot }) => snapshot.elements.flatMap((el) => {
		if (!isRendered(snapshot, el)) return []
		const surface = backdrop(snapshot, el, "none")
		if (!surface || luminance(surface) >= 0.1) return []
		const styles = [el.style, el.before?.style, el.after?.style].filter((s) => s !== undefined)
		const halo = styles.some((style) => splitLayers(style["background-image"] ?? "").some((layer) => {
			if (!layer.startsWith("radial-gradient(")) return false
			const stops = gradientStops(layer)
			const first = stops[0]
			const last = stops.at(-1)
			if (!first || !last || stops.some((s) => /(?:^|\s)(-?\d*\.?\d+)px/.test(s.raw) && Math.abs(Number.parseFloat(s.raw.slice(s.raw.lastIndexOf(" ") + 1))) <= 24)) return false
			return first.color.a >= 0.7 && spread(first.color) >= 24 && last.color.a <= 0.05
		}))
		return halo ? [{ element: el, message: "Chromatic radial halo on a dark surface", snippet: shortSnippet(el) }] : []
	}).slice(0, 1),
}
