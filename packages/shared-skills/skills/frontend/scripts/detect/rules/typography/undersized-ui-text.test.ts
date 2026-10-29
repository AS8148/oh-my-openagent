import { expect, test } from "bun:test"
import { buildSnapshot } from "../../testing/build-snapshot"
import { undersizedUiText } from "./undersized-ui-text"

test("#given functional text, legal floors and tolerant fluid sizes #then only undersized labels report", () => {
	const snapshot = buildSnapshot([
		{ id: "button", tag: "button", text: "Learn more", style: { "font-size": "10px" } },
		{ id: "floor", tag: "button", text: "Learn more", style: { "font-size": "10.9px" } },
		{ tag: "button", text: "Learn more", style: { "font-size": "10.9688px" } },
		{ tag: "button", text: "Learn more", style: { "font-size": "11px" } },
		{ tag: "footer", children: [
			{ text: "Copyright", style: { "font-size": "10px" } },
			{ id: "legal", text: "Copyright", style: { "font-size": "9.9px" } },
			{ id: "footer-link", tag: "a", text: "Privacy", attributes: { href: "#" }, style: { "font-size": "10px" } },
		] },
	])
	expect(undersizedUiText.check({ snapshot, config: {} }).map(h => h.element?.selector)).toEqual(["#button", "#floor", "#legal", "#footer-link"])
})

test("#given footnote links, code and nonfunctional prose #then ordinary short labels alone report", () => {
	const style = { "font-size": "8px" }
	const snapshot = buildSnapshot([
		{ id: "label", text: "Short label", style },
		{ tag: "sup", children: [{ tag: "a", text: "[7]", style, attributes: { href: "#" } }] },
		{ tag: "code", text: "const x = 1", style },
		{ text: "A long paragraph of body copy belongs to the tiny-text check.", style },
		{ text: "const result = { count: 3 };", style: { ...style, "font-family": "IBM Plex Mono", "white-space": "pre-wrap" } },
		{ text: "Hidden label", style, attributes: { class: "sr-only" } },
	])
	expect(undersizedUiText.check({ snapshot, config: {} }).map(h => h.element?.selector)).toEqual(["#label"])
})

test("#given furniture class parts and button groups #then only real furniture and button labels report", () => {
	const style = { "font-size": "9.5px" }
	const text = "A content-bearing label longer than twenty characters"
	const snapshot = buildSnapshot([
		...["taglist", "hero-tagline", "footer-subnav"].map((name, i) => ({ attributes: { class: name }, children: [{ id: `furniture-${i}`, text, style }] })),
		...["px-stage-compact", "instagram-feed", "pillars", "navy"].map(name => ({ attributes: { class: name }, children: [{ text, style }] })),
		{ id: "button", text, style, attributes: { class: "demo__btn" } },
		{ attributes: { class: "hero-btns btn-group" }, children: [
			{ text, style }, { text: "*Offer valid for new customers only. Terms and conditions apply to every plan.", style, attributes: { class: "offer-terms" } },
		] },
	])
	expect(undersizedUiText.check({ snapshot, config: {} }).map(h => h.element?.selector)).toEqual(["#furniture-0", "#furniture-1", "#furniture-2", "#button"])
})

test("#given JSON runs and monospace pricing #then punctuation identifies code rather than prices", () => {
	const style = { "font-size": "8px", "font-family": "IBM Plex Mono", "white-space": "pre-wrap" }
	const snapshot = buildSnapshot([
		{ text: '"data": {', style }, { text: '"id": 7,', style }, { text: '"title": "Introducing Directus",', style }, { text: "},", style },
		{ id: "price", text: "$50/seat", style }, { id: "count", text: "200+", style },
	])
	expect(undersizedUiText.check({ snapshot, config: {} }).map(h => h.element?.selector)).toEqual(["#price", "#count"])
})
