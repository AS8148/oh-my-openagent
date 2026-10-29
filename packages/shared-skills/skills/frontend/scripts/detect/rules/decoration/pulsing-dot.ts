import type { PageRule } from "../../rule"
import { shortSnippet } from "../../core/page"
import { radii, visible } from "./support/appearance"
import { dotPulse, infiniteNames, keyframes } from "./support/keyframes"
export const pulsingDot: PageRule = {
	meta: {
		id: "pulsing-dot",
		name: "Pulsing status dot",
		category: "slop",
		severity: "warning",
		engine: "page",
		description: "A tiny circular indicator pulses continuously.",
		fixHint: "Keep the indicator static unless it represents live changing data.",
	},
	check: ({ snapshot }) =>
		snapshot.elements.flatMap((e) => {
			const { width: w, height: h } = e.rect
			if (
				!visible(snapshot, e) ||
				w < 2 ||
				h < 2 ||
				w > 16 ||
				h > 16 ||
				Math.max(w, h) > 1.5 * Math.min(w, h) ||
				!radii(e).every((r) => r >= Math.min(w, h) * 0.4)
			)
				return []
			const names = infiniteNames(e.style)
			const pulse = names.some((n) => {
				const f = keyframes(snapshot, n)
				return f === null ? /pulse|ping|ripple|beacon/i.test(n) : dotPulse(f)
			})
			const tw = /(?:^|\s)animate-(?:ping|pulse)(?:$|\s)/.test(e.attributes["class"] ?? "")
			return pulse || tw ? [{ element: e, message: "Infinitely pulsing " + w + "x" + h + "px status dot", snippet: shortSnippet(e) }] : []
		}),
}
