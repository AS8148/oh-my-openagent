import { blend, contrastRatio } from "../../core/color"
import { ancestors, fontSizePx, shortSnippet, styleOf } from "../../core/page"
import type { PageRule } from "../../rule"
import { distinctPairs, type ContrastHit } from "./support/contrast-pairs"
import { gradientStops } from "./support/gradients"
import { textPainted } from "./support/painted-text"
import { clipsText, solidGround, textBackgrounds, textInk } from "./support/text-colors"

export const lowContrast: PageRule = {
	meta: {
		id: "low-contrast", name: "Low contrast text", category: "quality", severity: "error", engine: "page",
		description: "Text falls below the WCAG AA contrast ratio for its size.",
		fixHint: "Increase text and surface contrast to 4.5:1, or 3:1 for large text.",
	},
	check: ({ snapshot }) => distinctPairs(snapshot, snapshot.elements.flatMap((el): readonly ContrastHit[] => {
		if (!textPainted(snapshot, el)) return []
		if ([el, ...ancestors(snapshot, el)].some((node) => node.attributes["disabled"] !== undefined || node.attributes["aria-disabled"] === "true")) return []
		const size = fontSizePx(el)
		const familyWords = (styleOf(el, "font-family").split(",")[0] ?? "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/)
		const namedBold = familyWords.some((w) => ["bold", "semibold", "demibold", "extrabold", "ultrabold", "heavy", "black"].includes(w))
		const weight = namedBold ? Math.max(700, Number.parseFloat(styleOf(el, "font-weight")) || 400) : Number.parseFloat(styleOf(el, "font-weight"))
		const threshold = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5
		if (clipsText(el) && el.ownText.trim() !== "") {
			const stops = gradientStops(styleOf(el, "background-image"))
			if (stops.length === 0 || stops.some((s) => s.color.a < 0.999)) return []
			const ground = solidGround(snapshot, el)
			const best = Math.max(...stops.map((s) => contrastRatio(s.color, ground)))
			return best < threshold ? [{ element: el, pair: JSON.stringify([stops, ground, threshold]), message: `Gradient text contrast ${best.toFixed(2)}:1; needs ${threshold}:1`, snippet: shortSnippet(el) }] : []
		}
		const ink = textInk(snapshot, el)
		if (!ink) return []
		const backgrounds = textBackgrounds(snapshot, el)
		if (backgrounds.length === 0) return []
		const ratio = Math.min(...backgrounds.map((bg) => contrastRatio(blend(ink, bg), bg)))
		if (ratio === 1 && ![el, ...ancestors(snapshot, el)].some((node) =>
			["a", "button", "input", "select", "textarea"].includes(node.tag) || ["button", "link"].includes(node.attributes["role"] ?? ""))) return []
		const control = [el, ...ancestors(snapshot, el)].find((node) => node.tag === "button" || node.attributes["role"] === "button")
		if (ratio === 1 && control && control.children.length > 1 && control.text.trim() === el.text.trim()) return []
		const shape = size >= 96 && ink.a < 0.25 ? el.text : el.rect.width <= 48 && el.rect.height <= 48 && el.ownText.length <= 2 ? "avatar" : "copy"
		return ratio < threshold ? [{ element: el, pair: JSON.stringify([ink, backgrounds, threshold, shape]), message: `Text contrast ${ratio.toFixed(2)}:1; needs ${threshold}:1`, snippet: shortSnippet(el) }] : []
	})),
}
