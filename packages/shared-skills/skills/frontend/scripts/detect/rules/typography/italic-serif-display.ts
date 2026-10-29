import { descendants, fontSizePx, shortSnippet, styleOf } from "../../core/page"
import type { PageRule } from "../../rule"
import { visibleText } from "./support/text-context"

const serifNames = ["georgia", "times new roman", "times", "palatino", "garamond", "baskerville", "fraunces", "recoleta", "playfair display", "newsreader", "instrument serif", "lora", "merriweather", "libre baskerville", "cormorant garamond", "dm serif display", "dm serif text", "eb garamond", "source serif pro", "source serif 4"]

export const italicSerifDisplay: PageRule = {
	meta: {
		id: "italic-serif-display", name: "Italic serif display headline", category: "slop", severity: "warning", engine: "page",
		description: "An italic serif at hero scale repeats a common landing-page treatment.",
		fixHint: "Use roman type or a non-serif display face unless the brief calls for editorial typography.",
	},
	check: ({ snapshot }) => snapshot.elements.flatMap(element => {
		if (["h1", "h2"].includes(element.tag) === false || visibleText(snapshot, element) === false) return []
		const italic = [element, ...descendants(snapshot, element)].some(n => {
			const families = styleOf(n, "font-family").toLowerCase().split(",").map(f => f.trim().replace(/^['"]|['"]$/g, ""))
			const primary = families.find(f => ["serif", "sans-serif", "system-ui", "monospace", "inherit", "initial"].includes(f) === false)
			return visibleText(snapshot, n) && n.ownText.trim() !== "" && styleOf(n, "font-style") === "italic" &&
				fontSizePx(n) >= 48 && primary !== undefined && (serifNames.includes(primary) || families.includes("serif"))
		})
		return italic ? [{ element, message: "Italic serif heading at 48px or larger", snippet: shortSnippet(element) }] : []
	}),
}
