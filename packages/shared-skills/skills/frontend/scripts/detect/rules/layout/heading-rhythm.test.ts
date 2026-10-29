import { expect, test } from "bun:test"
import type { NodeSpec } from "../../testing/build-snapshot"
import { headingRhythm } from "./heading-rhythm"
import { lines, marked } from "./support/test-cases"

const group = (id: string, y: number, above = 0, below = 40): NodeSpec => ({
	style: { "border-top-width": "1px", "border-top-style": "solid", "border-top-color": "#333" },
	rect: { x: 24, y, width: 560, height: 220 }, children: [
		{ tag: "p", text: "A previous paragraph with enough prose to be read as the closing block of the previous section.", rect: { x: 24, y: y + 10, width: 560, height: 48 }, lineRects: lines([550, 400], 24, y + 10) },
		{ id, tag: "h2", text: "Section heading", style: { "font-size": "28px" }, rect: { x: 24, y: y + 58 + above, width: 560, height: 36 } },
		{ tag: "p", text: "The introduced content belongs to this heading.", rect: { x: 24, y: y + 94 + above + below, width: 560, height: 48 } },
	],
})

test("#given multiple crowded headings beside healthy gaps #then only crowded headings report", () => {
	expect(marked(headingRhythm, [group("one", 0), group("two", 240), group("healthy", 480, 64, 16)])).toEqual(["#one", "#two"])
	expect(marked(headingRhythm, [group("one", 0, 64, 16), group("two", 240, 64, 16)])).toEqual([])
})

test("#given one crowded heading #then the page minimum prevents a single local judgement", () => {
	expect(marked(headingRhythm, [group("one", 0), group("two", 240)])).toEqual(["#one", "#two"])
	expect(marked(headingRhythm, [group("one", 0)])).toEqual([])
})

test("#given equal gaps under running prose #then headings still attach to the previous block", () => {
	expect(marked(headingRhythm, [group("one", 0, 24, 24), group("two", 240, 20, 24)])).toEqual(["#one", "#two"])
	expect(marked(headingRhythm, [group("one", 0, 24, 20), group("two", 240, 24, 20)])).toEqual([])
})
