import { expect, test } from "bun:test"
import type { NodeSpec } from "../../testing/build-snapshot"
import { textOverflow } from "./text-overflow"
import { lines, marked } from "./support/test-cases"

const spill: NodeSpec = { id: "spill", tag: "p", text: "A long unbroken line of text spills outside this box.", rect: { x: 40, y: 40, width: 120, height: 40 }, scroll: { clientWidth: 120, scrollWidth: 300 }, lineRects: lines([300], 40, 40) }
const clip = (node: NodeSpec): NodeSpec => ({ style: { "overflow-x": "hidden" }, rect: { x: 20, y: 20, width: 200, height: 200 }, children: [node] })

test("#given spilled text under a clip and text in free space #then only harmful spill reports", () => {
	expect(marked(textOverflow, [clip(spill)])).toEqual(["#spill"])
	expect(marked(textOverflow, [spill])).toEqual([])
	expect(marked(textOverflow, [clip({ ...spill, lineRects: lines([100], 40, 40) })])).toEqual([])
})

test("#given explicit scroll and ellipsis affordances #then intentional containment is exempt", () => {
	expect(marked(textOverflow, [clip(spill)])).toEqual(["#spill"])
	expect(marked(textOverflow, [clip({ ...spill, style: { "overflow-x": "auto" } })])).toEqual([])
	expect(marked(textOverflow, [clip({ ...spill, style: { "overflow-x": "hidden", "text-overflow": "ellipsis" } })])).toEqual([])
})

test("#given inline text with ineffective ellipsis #then its block container determines the spill", () => {
	const inline = { ...spill, tag: "span", style: { display: "inline", "overflow-x": "hidden", "text-overflow": "ellipsis" }, scroll: { clientWidth: 0, scrollWidth: 0 } }
	expect(marked(textOverflow, [clip(inline)])).toEqual(["#spill"])
	expect(marked(textOverflow, [{ ...clip(inline), style: { "overflow-x": "hidden", "text-overflow": "ellipsis" } }])).toEqual([])
})

test("#given hidden or vertically clipped replacement text #then no invisible width spill reports", () => {
	expect(marked(textOverflow, [clip(spill)])).toEqual(["#spill"])
	expect(marked(textOverflow, [clip({ ...spill, style: { opacity: "0" } })])).toEqual([])
	expect(marked(textOverflow, [{ ...clip(spill), rect: { x: 20, y: 0, width: 200, height: 30 }, style: { "overflow-y": "hidden" } }])).toEqual([])
})

test("#given code in a scrolling page shell #then only a component scroller exempts it", () => {
	const code = { ...spill, tag: "pre", rect: { x: 1100, y: 40, width: 120, height: 40 }, lineRects: lines([500], 1100, 40) }
	expect(marked(textOverflow, [{ style: { "overflow-x": "auto" }, rect: { x: 0, y: 0, width: 1280, height: 800 }, children: [code] }])).toEqual(["#spill"])
	expect(marked(textOverflow, [{ style: { "overflow-x": "auto" }, rect: { x: 1100, y: 40, width: 120, height: 80 }, children: [code] }])).toEqual([])
})

test("#given code clipped in a terminal window #then its intentional crop is not harmful overflow", () => {
	expect(marked(textOverflow, [clip(spill)])).toEqual(["#spill"])
	expect(marked(textOverflow, [clip({ ...spill, tag: "pre" })])).toEqual([])
})

test("#given a generated suffix and an image replacement #then only painted overflow reports", () => {
	const suffix = { ...spill, lineRects: lines([50], 40, 40), after: { content: '" and a very long generated suffix"' } }
	expect(marked(textOverflow, [clip(suffix)])).toEqual(["#spill"])
	expect(marked(textOverflow, [clip({ ...spill, lineRects: lines([300], -9999, 40) })])).toEqual([])
})
