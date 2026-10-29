import type { PageRule } from "../../rule"
import { shortSnippet, styleOf } from "../../core/page"
import { visible, splitTop } from "./support/appearance"
import { geometricPolygon, roundedPath } from "./support/clip-geometry"
export const organicClipPath: PageRule = {
	meta: {
		id: "organic-clip-path",
		name: "Organic contour drawn as clip-path",
		category: "quality",
		severity: "warning",
		engine: "page",
		description: "A complex CSS contour substitutes for produced organic material.",
		fixHint: "Use an image-derived alpha matte; keep CSS clipping for simple geometry.",
	},
	check: ({ snapshot }) =>
		snapshot.elements.flatMap((e) => {
			if (!visible(snapshot, e)) return []
			const clip = styleOf(e, "clip-path"),
				kind = /^(polygon|path)\(([\s\S]*)\)$/.exec(clip),
				body = kind?.[2]
			if (!kind || body === undefined) return []
			const points = splitTop(body)
			const offGrid = [...body.matchAll(/[-+]?(?:\d*\.)?\d+/g)].filter(
				(m) => Math.abs(Number(m[0]) - Math.round(Number(m[0]) / 25) * 25) > 0.5,
			).length
			const organic =
				kind[1] === "path"
					? (body.match(/[CSQTA]/gi)?.length ?? 0) >= 3 && !roundedPath(body)
					: points.length >= 10 && offGrid >= points.length && !geometricPolygon(body)
			return organic ? [{ element: e, message: "Organic contour approximated with CSS " + kind[1], snippet: shortSnippet(e) }] : []
		}),
}
