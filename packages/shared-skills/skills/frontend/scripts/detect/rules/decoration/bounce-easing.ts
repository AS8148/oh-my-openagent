import type { PageRule } from "../../rule"
import { shortSnippet, styleOf } from "../../core/page"
import { borderSafe, splitTop, visible } from "./support/appearance"
import { keyframes, onlyUnitPulse, overshoot } from "./support/keyframes"
export const bounceEasing: PageRule = {
	meta: {
		id: "bounce-easing",
		name: "Bounce or elastic easing",
		category: "slop",
		severity: "advisory",
		engine: "page",
		description: "Animation names or timing curves imply overshooting motion.",
		fixHint: "Use a smooth deceleration or document an intentional easing in allowEasings.",
	},
	check: ({ snapshot, config }) =>
		snapshot.elements.flatMap((e) => {
			if (!visible(snapshot, e) || borderSafe.has(e.tag) || e.tag === "label") return []
			const allowed = (v: string): boolean =>
				(config.allowEasings ?? []).some((a) => a.replace(/\s/g, "").toLowerCase() === v.replace(/\s/g, "").toLowerCase())
			const names = splitTop(styleOf(e, "animation-name")).filter((n) => /bounce|elastic|wobble|jiggle|spring/i.test(n))
			const named = names.some((n) => {
				const f = keyframes(snapshot, n)
				return !allowed(n) && (f === null || !onlyUnitPulse(f))
			})
			const curves = [styleOf(e, "animation-timing-function"), styleOf(e, "transition-timing-function")]
				.flatMap((v) => splitTop(v))
				.filter((v) => !allowed(v) && overshoot(v))
			const tailwind = /(?:^|\s)animate-bounce(?:$|\s)/.test(e.attributes["class"] ?? "") && !allowed("animate-bounce")
			return named || tailwind || curves.length > 0
				? [
						{
							element: e,
							message: "Overshooting motion: " + (curves[0] ?? (names.join(",") || "animate-bounce")),
							snippet: shortSnippet(e),
						},
					]
				: []
		}),
}
