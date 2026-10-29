import { luminance, parseColor, toHsl, type Rgba } from "../../core/color"
import { ancestors, childrenOf, descendants, fontSizePx, shortSnippet, styleOf } from "../../core/page"
import type { PageHit, PageRule } from "../../rule"
import type { ElementSnapshot, PageSnapshot } from "../../types"
import { backdrop, colorDistance, gradientStops, opacity, sameColor, spread } from "./support/gradients"
import { brandColor, categoryColor, paletteVisible, tellHue } from "./support/palette-roles"
import { clipsText } from "./support/text-colors"

function highlighted(snapshot: PageSnapshot, el: ElementSnapshot): boolean {
	if (!/mono|consolas|courier/i.test(styleOf(el, "font-family")) || !["pre", "pre-wrap", "break-spaces"].includes(styleOf(el, "white-space")) || !styleOf(el, "display").startsWith("inline")) return false
	const parent = el.parent === null ? undefined : snapshot.elements[el.parent]
	const ink = parseColor(styleOf(el, "color"))
	if (!parent || !ink) return false
	return [parent, ...childrenOf(snapshot, parent)].some((node) => {
		if (node === el || node.ownText.trim() === "" || (node !== parent && !styleOf(node, "display").startsWith("inline")) || !paletteVisible(snapshot, node) || opacity(node) === 0) return false
		const c = parseColor(styleOf(node, "color"))
		return c !== null && c.a > 0 && (Math.abs(c.r - ink.r) + Math.abs(c.g - ink.g) + Math.abs(c.b - ink.b) > 24 || Math.abs(c.a - ink.a) > 0.1)
	})
}

function covered(snapshot: PageSnapshot, el: ElementSnapshot): boolean {
	return [...descendants(snapshot, el)].some((child) => {
		if (!["img", "video"].includes(child.tag) || !paletteVisible(snapshot, child) || styleOf(child, "object-fit") === "contain") return false
		const a = el.rect
		const b = child.rect
		return opacity(child) >= 0.95 && b.x <= a.x + 1 && b.y <= a.y + 1 && b.x + b.width >= a.x + a.width - 1 && b.y + b.height >= a.y + a.height - 1
	})
}

export const aiColorPalette: PageRule = {
	meta: {
		id: "ai-color-palette", name: "AI color palette", category: "slop", severity: "warning", engine: "page",
		description: "Stock violet and cyan ramps or paired neon inks replace an intentional palette.",
		fixHint: "Choose a distinctive palette and declare its colors as design tokens.",
	},
	check: ({ snapshot, config }) => {
		const allowed = config.designTokens?.colors?.map(parseColor).filter((c) => c !== null) ?? []
		const declared = (c: Rgba): boolean => allowed.some((token) => colorDistance(c, token) <= 6)
		const purpleDeclared = allowed.some((c) => tellHue(c) === "purple")
		const hits: PageHit[] = []
		const neon: { readonly el: ElementSnapshot; readonly hue: string }[] = []
		const tells = new Set<string>()
		for (const el of snapshot.elements) {
			if (!paletteVisible(snapshot, el)) continue
			const image = styleOf(el, "background-image")
			const stops = gradientStops(image).map((s) => s.color)
			const first = stops[0]
			const blurred = [el, ...ancestors(snapshot, el)].some((node) => [...styleOf(node, "filter").matchAll(/blur\(([\d.]+)px\)/g)].some((m) => Number(m[1]) >= 24))
			const flat = first !== undefined && (stops.every((c) => sameColor(c, first)) || (stops.every((c) => colorDistance(c, first) === 0) && stops.every((c) => c.a >= 0.75)))
			if (first && stops.length >= 2 && !flat && !blurred && !clipsText(el) && Math.min(el.rect.width, el.rect.height) >= 8 && el.rect.width * el.rect.height >= 256 && !covered(snapshot, el)) {
				const painted = stops.filter((c) => !declared(c) && c.a * opacity(el) >= 0.15 && spread(c) > 50)
				const bands = painted.map(tellHue).filter((h) => h !== null && !(h === "purple" && purpleDeclared))
				const bridge = painted.filter((c) => toHsl(c).h > 197 && toHsl(c).h < 260).length
				if (bands.length > 0 && bands.length * 2 >= painted.length && (bands.includes("purple") || bands.length * 2 > painted.length || bridge >= painted.length - bands.length)) {
					for (const band of bands) if (band) tells.add(band)
					if (!categoryColor(snapshot, el, true)) hits.push({ element: el, message: "Stock violet or cyan gradient background", snippet: shortSnippet(el) })
				}
			}
			const ink = parseColor(styleOf(el, "color"))
			if (!ink || declared(ink) || el.ownText.trim().length < 2 || highlighted(snapshot, el)) continue
			const band = tellHue(ink)
			if (band === "purple" && !purpleDeclared && spread(ink) > 50 && (["h1", "h2", "h3"].includes(el.tag) || (fontSizePx(el) >= 20 && toHsl(ink).s >= 0.3)) && !brandColor(snapshot, ink) && !categoryColor(snapshot, el, false)) {
				hits.push({ element: el, message: "Violet text on a heading", snippet: shortSnippet(el) })
			}
			const parent = el.parent === null ? undefined : snapshot.elements[el.parent]
			const ground = parent ? backdrop(snapshot, parent) : null
			if (band && !(band === "purple" && purpleDeclared) && ink.a * opacity(el) >= 0.15 && spread(ink) > 80 && ground && luminance(ground) < 0.1) {
				tells.add(band)
				neon.push({ el, hue: band })
			}
		}
		if (tells.size >= 2) for (const { el } of neon) if (!categoryColor(snapshot, el, false)) hits.push({ element: el, message: "Neon text paired with another stock palette hue on dark", snippet: shortSnippet(el) })
		return hits
	},
}
