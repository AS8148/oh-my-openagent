import { describe, expect, test } from "bun:test"

import { isHiddenElement, tagAttributes, visibleMarkup } from "./html-visible.mjs"

const seen = (html: string) => visibleMarkup(html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()

describe("visibleMarkup", () => {
	test.each([
		["a comment", "a <!-- b --> c"],
		["a hidden attribute", "a <span hidden>b</span> c"],
		["display:none !important", "a <span style=\"color:red; display: none !important\">b</span> c"],
		["visibility:collapse", "a <span style='visibility:collapse'>b</span> c"],
		["font-size:0", "a <span style=\"font-size: 0em\">b</span> c"],
		["opacity:0", "a <span style=\"opacity:0\">b</span> c"],
		["a template", "a <template><p>b</p></template> c"],
		["a script holding markup", "a <script>x = \"<span>b</span>\"</script> c"],
	])("drops content hidden by %s", (_label, html) => {
		expect(seen(html)).toBe("a c")
	})

	test("keeps visible styling and aria-hidden content, which browsers render", () => {
		expect(seen("a <span style=\"opacity:0.5; font-size:12px\" aria-hidden=\"false\">b</span> c")).toBe("a b c")
		expect(seen("a <span aria-hidden=true>b</span> c")).toBe("a b c")
	})

	test("counts nested elements of the same name", () => {
		expect(seen("<div hidden><div>a</div>b</div>c")).toBe("c")
	})

	test("an unclosed hidden element hides to the end of the input", () => {
		expect(seen("a <div hidden>b <p>c</p>")).toBe("a")
	})

	test("isHiddenElement reads only rendered-visibility attributes", () => {
		expect(isHiddenElement("span", { title: "hidden" })).toBe(false)
		expect(isHiddenElement("head", {})).toBe(true)
	})
})

describe("tagAttributes", () => {
	test("parses double, single and unquoted values in order and skips comments", () => {
		const tags = tagAttributes("<a href=\"/x\">1</a><!-- <a href=/c> --><a href='/y'>2</a><a href=/z>3</a>")
		expect(tags.map((tag: { attrs: Record<string, string> }) => tag.attrs.href)).toEqual(["/x", "/y", "/z"])
	})
})
