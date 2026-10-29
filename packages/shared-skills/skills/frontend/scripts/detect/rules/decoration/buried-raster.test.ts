import { test } from "bun:test"
import { buriedRaster } from "./buried-raster"
import { assertCases } from "./support/assert-cases"
import type { NodeSpec } from "../../testing/build-snapshot"
test("#given raster images under near opaque washes #then legible tints and reversed layers pass", () => {
	const image = "url(photo.png)",
		wash = "linear-gradient(rgba(240,237,226,.96),rgba(240,237,226,.96))",
		tint = "linear-gradient(rgba(0,0,0,.45),rgba(0,0,0,.45))"
	assertCases(
		buriedRaster,
		[
			{ id: "flag", style: { "background-image": wash + ", " + image } },
			{ id: "tint", style: { "background-image": tint + ", " + image } },
			{ id: "reverse", style: { "background-image": image + ", " + wash } },
			{ id: "gradient", style: { "background-image": wash } },
			{ id: "blend", style: { "background-image": wash + ", " + image, "background-blend-mode": "multiply" } },
		],
		["#flag"],
	)
})
test("#given faint produced rasters #then SVG sources and icon sized state images pass", () => {
	assertCases(
		buriedRaster,
		[
			{ id: "flag", tag: "img", attributes: { src: "paper.png" }, rect: { width: 400, height: 300 }, style: { opacity: "0.04" } },
			{ id: "icon", tag: "img", attributes: { src: "pin.png" }, rect: { width: 24, height: 24 }, style: { opacity: "0" } },
			{ id: "svg", tag: "img", attributes: { src: "icon.svg?state=on" }, style: { opacity: "0" } },
			{ id: "text", text: "Faint text", style: { opacity: ".04" } },
		],
		["#flag"],
	)
})
test("#given overlapping crossfade and blurred placeholders #then isolated faint rasters remain findings", () => {
	const photo = (id: string, opacity: string): NodeSpec => ({
		id,
		tag: "img",
		attributes: { src: "photo.png" },
		rect: { width: 320, height: 180 },
		style: { opacity },
	})
	assertCases(
		buriedRaster,
		[
			{ children: [photo("flag", ".04"), { tag: "p", text: "Copy" }] },
			{ children: [photo("painted", "1"), photo("frame", "0")] },
			{ ...photo("blurred", "0"), style: { opacity: "0", filter: "blur(10px)" } },
		],
		["#flag"],
	)
})
