import { blend, contrastRatio } from "../../core/color"
import { ancestors, fontSizePx, shortSnippet, styleOf } from "../../core/page"
import type { PageRule } from "../../rule"
import { gradientStops } from "./support/gradients"
import { clipsText, solidGround, textBackgrounds, textInk } from "./support/text-colors"

export const lowContrast: PageRule = {
	meta: {
		id: "low-contrast", name: "Low contrast text", category: "quality", severity: "error", engine: "page",
		description: "Text falls below the WCAG AA contrast ratio for its size.",
		fixHint: "Increase text and surface contrast to 4.5:1, or 3:1 for large text.",
	},
	check: ({ snapshot }) => snapshot.elements.flatMap((el) => {
		if ([el, ...ancestors(snapshot, el)].some((node) => node.attributes["disabled"] !== undefined || node.attributes["aria-disabled"] === "true")) return []
		const size = fontSizePx(el)
		const weight = Number.parseFloat(styleOf(el, "font-weight"))
		const threshold = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5
		if (clipsText(el) && el.ownText.trim() !== "") {
			const stops = gradientStops(styleOf(el, "background-image"))
			if (stops.length === 0 || stops.some((s) => s.color.a < 0.999)) return []
			const ground = solidGround(snapshot, el)
			const best = Math.max(...stops.map((s) => contrastRatio(s.color, ground)))
			return best < threshold ? [{ element: el, message: `Gradient text contrast ${best.toFixed(2)}:1; needs ${threshold}:1`, snippet: shortSnippet(el) }] : []
		}
		const ink = textInk(snapshot, el)
		if (!ink) return []
		const backgrounds = textBackgrounds(snapshot, el)
		if (backgrounds.length === 0) return []
		const ratio = Math.min(...backgrounds.map((bg) => contrastRatio(blend(ink, bg), bg)))
		return ratio < threshold ? [{ element: el, message: `Text contrast ${ratio.toFixed(2)}:1; needs ${threshold}:1`, snippet: shortSnippet(el) }] : []
	}),
}
