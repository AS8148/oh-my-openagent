import { expect, test } from "bun:test"
import { contentHiddenAtRest } from "./content-hidden-at-rest"
import { marked } from "./support/test-cases"

const hidden = { id: "reveal", style: { opacity: "0" }, text: "Invisible main content. ".repeat(10) }
const visible = { tag: "p", text: "Visible copy. ".repeat(10) }

test("#given a failed reveal and visible content #then the page fails the hidden share threshold", () => {
	expect(marked(contentHiddenAtRest, [hidden, visible])).toEqual(["page"])
	expect(marked(contentHiddenAtRest, [{ ...hidden, style: { opacity: "1" } }, visible])).toEqual([])
})

test("#given closed dialogs menus and panels #then their text is excluded from the hidden share", () => {
	expect(marked(contentHiddenAtRest, [hidden, visible])).toEqual(["page"])
	for (const role of ["dialog", "tabpanel", "menu"]) {
		expect(marked(contentHiddenAtRest, [{ ...hidden, attributes: { role } }, visible])).toEqual([])
	}
	expect(marked(contentHiddenAtRest, [{ tag: "nav", children: [hidden] }, visible])).toEqual([])
})

test("#given a selected tab panel whose reveal failed #then it counts as expected content", () => {
	const panel = { ...hidden, attributes: { role: "tabpanel" } }
	expect(marked(contentHiddenAtRest, [{ tag: "button", attributes: { "aria-controls": "reveal", "aria-selected": "true" } }, panel, visible])).toEqual(["page"])
	expect(marked(contentHiddenAtRest, [{ tag: "button", attributes: { "aria-controls": "reveal", "aria-selected": "false" } }, panel, visible])).toEqual([])
})

test("#given the character and share boundaries #then only substantial hidden content fails", () => {
	expect(marked(contentHiddenAtRest, [{ ...hidden, text: "x".repeat(150) }, { text: "v".repeat(50) }])).toEqual(["page"])
	expect(marked(contentHiddenAtRest, [{ ...hidden, text: "x".repeat(149) }, { text: "v".repeat(51) }])).toEqual([])
	expect(marked(contentHiddenAtRest, [{ ...hidden, text: "x".repeat(150) }, { text: "v".repeat(350) }])).toEqual([])
})
