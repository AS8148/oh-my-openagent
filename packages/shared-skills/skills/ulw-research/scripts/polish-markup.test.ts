import { describe, expect, test } from "bun:test"

import { applyEdits } from "./polish-apply.mjs"
import { diffPolish } from "./polish-diff.mjs"

const LEDGER = { rows: [{ fact_id: "F1", quote: "Revenue may reach 320 m." }] }
const FACT = '<data data-fact="F1">320 m</data>'
const BASE = `<p id="a" class="plain" style="color:red">Revenue may reach ${FACT} this year.</p>`

// The public polish boundary must freeze bytes, not inferred HTML/CSS semantics.
const MARKUP_CASES = [
	["hidden added", BASE, BASE.replace('<p ', '<p hidden ')],
	["id changed under existing CSS", `<style>#gone{display:none}</style>${BASE}`, `<style>#gone{display:none}</style>${BASE.replace('id="a"', 'id="gone"')}`],
	["class changed", BASE, BASE.replace('class="plain"', 'class="gone"')],
	["style changed", BASE, BASE.replace("color:red", "display:none")],
	["stylesheet inserted", BASE, `<style>.plain{display:none}</style>${BASE}`],
	["self-closing slash added", BASE, BASE.replace('color:red">', 'color:red"/>')],
	["wrapper added", BASE, BASE.replace(FACT, `<span>${FACT}</span>`)],
	["wrapper removed", BASE.replace(FACT, `<span>${FACT}</span>`), BASE],
	["comment added", BASE, `${BASE}<!-- note -->`],
	["comment changed", `${BASE}<!-- note -->`, `${BASE}<!-- notes -->`],
	["attribute reorder", BASE, BASE.replace('id="a" class="plain"', 'class="plain" id="a"')],
	["attribute quote changed", BASE, BASE.replace('id="a"', "id='a'")],
	["attribute name case changed", BASE, BASE.replace('id="a"', 'ID="a"')],
	["duplicate attribute changed", BASE.replace('<p ', '<p id="first" '), BASE.replace('<p ', '<p id="other" ')],
	["href changed", '<a href="/a">Reference</a>', '<a href="/b">Reference</a>'],
	["closing tag changed", BASE, BASE.replace("</p>", "</div>")],
	["tag renamed", "<p>Results may improve.</p>", "<div>Results may improve.</div>"],
	["tag whitespace changed", BASE, BASE.replace('<p ', '<p  ')],
	["declaration changed", `<!doctype html>${BASE}`, `<!DOCTYPE html>${BASE}`],
	["script content changed", `${BASE}<script>let x = "note"</script>`, `${BASE}<script>let x = "notes"</script>`],
	["style content changed", `${BASE}<style>.a{color:red}</style>`, `${BASE}<style>.a{color:tan}</style>`],
	["template text changed", `${BASE}<template>note</template>`, `${BASE}<template>notes</template>`],
	["nested template text changed", `${BASE}<template><template>x</template>note</template>`, `${BASE}<template><template>x</template>notes</template>`],
	["unclosed script content changed", `${BASE}<script>note`, `${BASE}<script>notes`],
	["unclosed template content changed", `${BASE}<template>note`, `${BASE}<template>notes`],
] as const

describe("polish text-node-only markup contract", () => {
	test.each(MARKUP_CASES)("#given %s #then apply refuses markup changed and diff blocks", (_label: string, before: string, after: string) => {
		const result = applyEdits(before, [{ before, after }], LEDGER)
		expect(result.applied).toEqual([])
		expect(result.out).toBe(before)
		expect(result.rejected[0]?.reason).toContain("markup changed")
		const defects = diffPolish(before, after, LEDGER)
		expect(defects.find((item: { code: string }) => item.code === "polish_diff_fail")?.severity).toBe("blocker")
	})

	test.each([
		["existing self-closing hidden span", `<p>Revenue ${FACT} may rise. <span hidden/> Fine.</p>`, `<p>Revenue ${FACT} rise. <span hidden/> may Fine.</p>`],
		["existing closed dialog", `<p>Revenue ${FACT} may rise.</p><dialog>Note.</dialog>`, `<p>Revenue ${FACT} rise.</p><dialog>may Note.</dialog>`],
		["existing duplicate hidden style", '<p>Results may improve.</p><div style="display:none" style="color:red">Note.</div>', '<p>Results improve.</p><div style="display:none" style="color:red">may Note.</div>'],
		["aria-hidden fact text", `<p>Revenue <span aria-hidden="true">${FACT}</span> may rise.</p>`, `<p>Revenue <span aria-hidden="true">${FACT.replace("320", "321")}</span> may rise.</p>`],
		["plain text inside aria-hidden fact", '<q data-fact="F1" aria-hidden="true">Revenue may rise.</q>', '<q data-fact="F1" aria-hidden="true">Revenue may soar.</q>'],
		["number moved between text nodes", "<p>Revenue 320 m.</p><span hidden>Note.</span>", "<p>Revenue.</p><span hidden>320 m Note.</span>"],
	])("#given %s #then protected text cannot migrate or change", (_label: string, before: string, after: string) => {
		expect(applyEdits(before, [{ before, after }], LEDGER).applied).toEqual([])
		expect(diffPolish(before, after, LEDGER).length).toBeGreaterThan(0)
	})

	test.each([
		["plain prose", "<p>Results may improve steadily.</p>", "<p>Results may improve slowly.</p>"],
		["prose beside a fact", BASE, BASE.replace("this year", "next year")],
		["quoted greater-than attribute", '<p title="a>b">Results may improve steadily.</p>', '<p title="a>b">Results may improve slowly.</p>'],
		["literal less-than text", "<p>Growth < limits may persist steadily.</p>", "<p>Growth < limits may persist slowly.</p>"],
		["unchanged frozen content", "<style>.a{display:none}</style><template>note</template><p>Results may improve steadily.</p>", "<style>.a{display:none}</style><template>note</template><p>Results may improve slowly.</p>"],
	])("#given %s #then pure text polish with protected tokens intact passes", (_label: string, before: string, after: string) => {
		expect(applyEdits(before, [{ before, after }], LEDGER).out).toBe(after)
		expect(diffPolish(before, after, LEDGER)).toEqual([])
	})
})
