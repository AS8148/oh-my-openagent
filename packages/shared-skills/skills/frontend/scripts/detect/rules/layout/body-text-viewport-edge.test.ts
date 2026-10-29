import { expect, test } from "bun:test"
import { bodyTextViewportEdge } from "./body-text-viewport-edge"
import { lines, marked } from "./support/test-cases"

const prose = "This paragraph contains substantial reading text that needs a gutter at either side of the page."

test("#given full width prose with and without a gutter #then only edge touching text reports", () => {
	expect(marked(bodyTextViewportEdge, [
		{ id: "flush", tag: "p", text: prose, rect: { width: 1280, height: 80 }, lineRects: lines([1280, 100], 0, 0) },
		{ id: "inset", tag: "p", text: prose, rect: { width: 1280, height: 80 }, lineRects: lines([1200], 40, 100) },
	])).toEqual(["#flush"])
})

test("#given a phone gutter of twelve pixels #then phone and desktop floors differ", () => {
	const node = { id: "copy", tag: "p", text: prose, rect: { x: 12, width: 296 }, lineRects: lines([296], 12, 0) }
	expect(marked(bodyTextViewportEdge, [node], { viewport: { width: 320, height: 800 } })).toEqual([])
	expect(marked(bodyTextViewportEdge, [{ ...node, rect: { x: 12, width: 1256 }, lineRects: lines([1256], 12, 0) }])).toEqual(["#copy"])
})

test("#given navigation and scrollable tracks beside body content #then only body content keeps the gutter requirement", () => {
	const node = { id: "copy", tag: "p", text: prose, rect: { width: 1280 }, lineRects: lines([1280], 0, 0) }
	expect(marked(bodyTextViewportEdge, [node])).toEqual(["#copy"])
	expect(marked(bodyTextViewportEdge, [{ tag: "nav", children: [node] }])).toEqual([])
	expect(marked(bodyTextViewportEdge, [{ style: { "overflow-x": "auto" }, children: [node] }])).toEqual([])
})

test("#given body text past the window #then overflow is reported once at page level", () => {
	const node = { tag: "p", text: prose, rect: { x: 40, width: 1600 }, lineRects: lines([1600], 40, 0) }
	expect(marked(bodyTextViewportEdge, [node, node])).toEqual(["page"])
	expect(marked(bodyTextViewportEdge, [{ ...node, rect: { x: 1400, width: 1600 }, lineRects: lines([1600], 1400, 0) }])).toEqual([])
})
