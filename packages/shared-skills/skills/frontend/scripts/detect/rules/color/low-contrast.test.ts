import { expect, test } from "bun:test"
import { lintSnapshot } from "../../lint"
import { buildSnapshot } from "../../testing/build-snapshot"
import { lowContrast } from "./low-contrast"

const ink = (color: string): Readonly<Record<string, string>> => ({ color, "-webkit-text-fill-color": color })

test("#given small, large and bold text around AA thresholds #then only failures report", () => {
	const snapshot = buildSnapshot([
		{ id: "small-fail", text: "Faint body", style: ink("#777777") },
		{ id: "small-pass", text: "Readable body", style: ink("#767676") },
		{ id: "large-fail", text: "Faint heading", style: { ...ink("#9b9b9b"), "font-size": "24px" } },
		{ id: "large-pass", text: "Readable heading", style: { ...ink("#949494"), "font-size": "24px" } },
		{ id: "bold-fail", text: "Faint bold", style: { ...ink("#9c9c9c"), "font-size": "19px", "font-weight": "700" } },
		{ id: "bold-pass", text: "Readable bold", style: { ...ink("#949494"), "font-size": "19px", "font-weight": "700" } },
	])
	expect(lowContrast.check({ snapshot, config: {} }).map((h) => h.element?.selector)).toEqual(["#small-fail", "#large-fail", "#bold-fail"])
	expect(lintSnapshot(snapshot, { rules: [lowContrast] }).every((h) => h.severity === "error")).toBe(true)
})

test("#given repeated pairs and an ignored first copy #then one readable claimant counts unwaived copies", () => {
	const snapshot = buildSnapshot([
		{ id: "waived", text: "Waived copy", style: ink("#bbbbbb"), attributes: { "data-detect-ignore": "low-contrast" } },
		{ id: "glyph", text: "𝕏", style: ink("#bbbbbb") },
		{ id: "word", text: "Share this idea", style: ink("#bbbbbb") },
		{ id: "repeat", text: "Share another idea", style: ink("#bbbbbb") },
		{ id: "pass", text: "Readable ink", style: ink("#333333") },
	])
	const hits = lowContrast.check({ snapshot, config: {} })
	expect(hits.map((h) => h.element?.selector)).toEqual(["#word"])
	expect(hits[0]?.message.endsWith("(and 2 more)")).toBe(true)
})

test("#given named heavy cuts and ordinary family names #then only bold cuts get the large text bar", () => {
	const snapshot = buildSnapshot(["ProximaNovaBold", "EMprint Semibold", "Gotham-Black", "Blackletter Text", 'Georgia, "Arial Black"'].map((family, i) => ({
		id: `face-${i}`, text: "Family weight", style: { ...ink("#ffffff"), "background-color": "#ff5757", "font-size": "19px", "font-family": family },
	})))
	expect(lowContrast.check({ snapshot, config: {} }).map((h) => h.element?.selector)).toEqual(["#face-3"])
})

test("#given scrims, pseudo faces and parked underlines #then contrast uses the painted surface", () => {
	const snapshot = buildSnapshot([
		{ style: { position: "relative" }, rect: { width: 500, height: 200 }, children: [
			{ style: { position: "absolute", "background-color": "rgba(0,0,0,0.8)" }, rect: { width: 500, height: 200 } },
			{ style: { position: "absolute", "background-color": "rgba(235,230,224,0.3)" }, rect: { width: 500, height: 200 }, children: [
				{ id: "scrim-pass", text: "White title on scrim", style: ink("#f7f5f3") },
			] },
		] },
		{ id: "pseudo-fail", text: "Dark label", rect: { y: 300 }, style: ink("#333333"), before: { "background-color": "#1a1a1a" } },
		{ id: "parked-pass", text: "Readable dark label", rect: { y: 400 }, style: ink("#333333"), before: { "background-color": "#1a1a1a", transform: "matrix(1, 0, 0, 1, -300, 0)" } },
		{ id: "drawn-fail", text: "Ink on itself", rect: { y: 500 }, style: { ...ink("#5d666d"), "background-image": "linear-gradient(#5d666c, #5d666c)", "background-size": "100% 100%" } },
		{ id: "underline-pass", text: "Ink with parked underline", rect: { y: 600 }, style: { ...ink("#5d666c"), "background-image": "linear-gradient(#5d666c, #5d666c)", "background-size": "0px 1px" } },
	])
	expect(lowContrast.check({ snapshot, config: {} }).map((h) => h.element?.selector)).toEqual(["#pseudo-fail", "#drawn-fail"])
})

test("#given stacked opaque panels and a mask fade #then hidden text cannot claim a pair", () => {
	const snapshot = buildSnapshot([
		{ rect: { width: 600, height: 200 }, children: [
			{ style: { "z-index": "2", "background-color": "#ffffff" }, rect: { width: 600, height: 200 }, children: [{ id: "active", text: "Faint active copy", style: ink("#a0a0a0") }] },
			{ style: { "z-index": "0", "background-color": "#ffffff" }, rect: { width: 600, height: 200 }, children: [{ id: "covered", text: "Faint covered copy", style: ink("#a1a1a1") }] },
		] },
		{ rect: { y: 300, width: 400, height: 160 }, style: { "mask-image": "linear-gradient(#000000 100px, transparent 140px)" }, children: [
			{ id: "clear", rect: { y: 320 }, text: "Clear zone", style: ink("#a2a2a2") },
			{ id: "masked", rect: { y: 440 }, text: "Masked zone", style: ink("#a3a3a3") },
		] },
	])
	expect(lowContrast.check({ snapshot, config: {} }).map((h) => h.element?.selector)).toEqual(["#active", "#clear"])
})

test("#given a delayed entrance and a fading loop #then final entrance text reports but loop frames do not", () => {
	const snapshot = buildSnapshot([
		{ style: { opacity: "0", "animation-name": "enter", "animation-iteration-count": "1" }, children: [
			{ id: "enter", tag: "a", text: "Get started", style: ink("#bbbbbb") },
		] },
		{ style: { opacity: "0.2", "animation-name": "cycle", "animation-iteration-count": "infinite" }, children: [
			{ id: "cycle", text: "A loop frame", style: ink("#bbbbbb") },
		] },
		{ id: "readable", text: "Readable copy", style: ink("#111111") },
	], { cssText: ["@keyframes enter { from { opacity: 0; } to { opacity: 1; } } @keyframes cycle { 0% { opacity: 0; } 40% { opacity: 1; } 100% { opacity: 0; } }"] })
	expect(lowContrast.check({ snapshot, config: {} }).map((h) => h.element?.selector)).toEqual(["#enter"])
})

test("#given alpha ink, inherited surfaces, gradients and disabled controls #then painted failures report", () => {
	const snapshot = buildSnapshot([
		{ style: { "background-color": "#000000" }, children: [
			{ id: "alpha-fail", text: "Faint alpha", style: ink("rgba(255,255,255,0.1)") },
			{ id: "alpha-pass", text: "Readable alpha", style: ink("rgba(255,255,255,0.9)") },
		] },
		{ tag: "button", attributes: { disabled: "" }, children: [{ id: "disabled", text: "Disabled", style: ink("#cccccc") }] },
		{ id: "gradient-fail", text: "Faint gradient", style: { "background-image": "linear-gradient(#dddddd, #eeeeee)", ...ink("#bbbbbb") } },
		{ id: "transparent", text: "Hidden fill", style: ink("transparent") },
		{ id: "photo", text: "Unknown background", style: { ...ink("#cccccc"), "background-image": "url(photo.jpg)" } },
	])
	expect(lowContrast.check({ snapshot, config: {} }).map((h) => h.element?.selector)).toEqual(["#alpha-fail", "#gradient-fail"])
})

test("#given pale clipped text and waived plain text #then only unwaived failures report", () => {
	const snapshot = buildSnapshot([
		{ id: "clip-fail", text: "Pale glyphs", style: { "background-clip": "text", "background-image": "linear-gradient(#dddddd, #eeeeee)", ...ink("transparent") } },
		{ id: "clip-pass", text: "Dark glyphs", style: { "background-clip": "text", "background-image": "linear-gradient(#111111, #333333)", ...ink("transparent") } },
		{ id: "waived", text: "Waived faint text", style: ink("#cccccc"), attributes: { "data-detect-ignore": "low-contrast" } },
	])
	expect(lintSnapshot(snapshot, { rules: [lowContrast] }).map((h) => h.location.kind === "element" ? h.location.selector : "")).toEqual(["#clip-fail"])
})
