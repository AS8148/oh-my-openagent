import type { SourceRule } from "../../rule"
import { lineCheck, sourceExtensions } from "./support/source-text"

export const bounceEasing: SourceRule = {
	meta: { id: "bounce-easing", name: "Bounce or elastic easing", category: "slop", severity: "advisory", engine: "source", description: "A named bounce animation or overshooting timing curve adds elastic motion.", fixHint: "Use a smooth deceleration, or allow an intentional timing function." },
	extensions: sourceExtensions,
	check: lineCheck([/\banimate-bounce\b/g, /animation(?:-name)?\s*:\s*([^;{}]*(?:bounce|elastic|wobble|jiggle|spring)[^;{}]*)/gi, /cubic-bezier\(\s*([0-9.-]+)\s*,\s*([0-9.-]+)\s*,\s*([0-9.-]+)\s*,\s*([0-9.-]+)\s*\)/g], ({ match, context }) => {
		const canonical = (s: string): string => s.replace(/\s/g, "").toLowerCase()
		if (context.config.allowEasings?.some((easing) => canonical(easing) === canonical(match[0]) || canonical(easing) === canonical((match[1] ?? "").trim()))) return null
		if (match[4] !== undefined) {
			const y1 = Number(match[2])
			const y2 = Number(match[4])
			return y1 < -0.1 || y1 > 1.1 || y2 < -0.1 || y2 > 1.1 ? `cubic-bezier(${match.slice(1).join(", ")})` : null
		}
		if (match[1]) return `animation: ${match[1].split(/[,\s]+/).find((s) => /bounce|elastic|wobble|jiggle|spring/i.test(s)) ?? match[1].trim()}`
		return "animate-bounce (Tailwind)"
	}),
}
