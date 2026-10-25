import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { unmarkedKinds } from "./claim-kinds.mjs"
import { valueChecks } from "./fidelity-values.mjs"
import { buildContext } from "./gates-static.mjs"
import { parseHtml } from "./html-lite.mjs"

const FIX = join(import.meta.dir, "tests", "fixtures", "fidelity")
const ledger = JSON.parse(readFileSync(join(FIX, "ledger-verify.json"), "utf8"))

for (const verb of ["confirmed", "validated", "checked", "observed", "measured", "ran"]) {
	test(`#given we ${verb} an unmarked claim #when verified #then verification_claim_unmarked warns`, () => {
		const html = `<h2>Findings</h2><p>We ${verb} that the recorded span is up to <data data-fact="F1">320 m</data> [S4].</p>`
		const defects = valueChecks(buildContext(parseHtml(html), {}), ledger, null, join(FIX, "sources"))
		expect(defects).toContainEqual(expect.objectContaining({ code: "verification_claim_unmarked", severity: "minor" }))
	})
}

for (const text of [
	"We use confirmed values, validated inputs, checked references, observed events, and measured responses.",
	"The authors confirmed that the value was measured.",
	"We ran out of time.",
	"We checked in at the hotel.",
]) {
	test(`#given non-verification prose "${text}" #when cues are scanned #then no warning`, () => {
		expect(unmarkedKinds(text)).toEqual([])
	})
}
