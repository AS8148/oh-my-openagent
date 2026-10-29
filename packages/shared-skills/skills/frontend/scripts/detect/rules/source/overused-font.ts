import type { SourceRule } from "../../rule"
import { lineCheck, sourceExtensions } from "./support/source-text"

const fonts = ["Inter", "Roboto", "Open Sans", "Lato", "Montserrat", "Arial", "Helvetica", "Fraunces", "Geist Sans", "Geist Mono", "Geist", "Mona Sans", "Plus Jakarta Sans", "Space Grotesk", "Recoleta", "Instrument Sans", "Instrument Serif"]

export const overusedFont: SourceRule = {
	meta: { id: "overused-font", name: "Overused font", category: "slop", severity: "warning", engine: "source", description: "A familiar default typeface appears in a font declaration or import.", fixHint: "Choose a typeface suited to the product, or allow the intentional family." },
	extensions: sourceExtensions,
	check: lineCheck([new RegExp(`font-family\\s*:\\s*['"]?(${fonts.join("|")})\\b`, "gi"), /fonts\.googleapis\.com\/css2?\?[^"'\s)<>]*/gi], ({ match, context }) => {
		const family = match[1] ?? [...match[0].matchAll(/[?&]family=([^&:|]+)/g)].flatMap((m) => (m[1] ?? "").split("|")).map((f) => decodeURIComponent(f.replace(/\+/g, " "))).find((f) => fonts.some((font) => font.toLowerCase() === f.toLowerCase()))
		if (!family || context.config.allowFonts?.some((f) => f.toLowerCase() === family.toLowerCase())) return null
		return match[1] ? match[0] : `Google Fonts: ${family.toLowerCase()}`
	}),
}
