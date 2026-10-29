import { test } from "bun:test"
import { marquee } from "./marquee"
import { assertCases } from "./support/assert-cases"

test("#given infinite crawling content and empty ornaments #then only content tracks report", () => {
	const style = { "animation-name": "crawl", "animation-iteration-count": "infinite" }
	assertCases(
		marquee,
		[
			{ id: "words", text: "New arrivals every Friday", style },
			{ id: "logos", style, children: [{ tag: "svg", attributes: { role: "img" } }] },
			{ id: "wave", tag: "svg", style, attributes: { "aria-hidden": "true" }, children: [{ tag: "path" }] },
			{ id: "sweep", style },
		],
		["#words", "#logos"],
		{ cssText: ["@keyframes crawl {from{transform:translateX(0)}to{transform:translateX(-50%)}}"] },
	)
})
test("#given moving pseudo content #then host words do not make empty sheens marquees", () => {
	const pseudo = { "animation-name": "flow", "animation-iteration-count": "infinite" }
	assertCases(
		marquee,
		[
			{ id: "ticker", before: { ...pseudo, content: '"Sale New arrivals"' } },
			{ id: "sheen", text: "Release news", before: { ...pseudo, content: '""' } },
			{ id: "plain", text: "Still content" },
		],
		["#ticker"],
		{ cssText: ["@keyframes flow {from{transform:translateX(-48%)}to{transform:translateX(48%)}}"] },
	)
})
test("#given nested and native marquees #then each moving content strip reports once", () => {
	assertCases(
		marquee,
		[
			{
				id: "flag",
				tag: "marquee",
				text: "Sale",
				children: [{ id: "nested", text: "Sale", style: { "animation-name": "ticker", "animation-iteration-count": "infinite" } }],
			},
			{ id: "still", text: "Calm" },
		],
		["#flag"],
	)
})
