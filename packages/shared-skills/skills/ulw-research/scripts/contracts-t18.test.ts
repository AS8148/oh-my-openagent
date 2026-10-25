/// <reference types="bun-types" />
import { expect, test } from "bun:test"

import { DEFECT_CODES, validateOutcomeManifest } from "./contracts.mjs"
import { initManifest } from "./outcome.mjs"
import { parsePlaceholder } from "./placeholder.mjs"

test("task 18 retains existing defect severity and integrity contracts", () => {
	for (const code of ["unsourced_number", "untraceable_number"]) {
		expect(DEFECT_CODES[code]).toMatchObject({ severity: "major", integrity: false })
	}
	expect(DEFECT_CODES.verification_claim_unmarked).toMatchObject({ severity: "minor", integrity: false })
	expect(DEFECT_CODES.unresolved_placeholder).toMatchObject({ severity: "blocker", integrity: true })
})

test("D marks bind the documented F identifier without adding another value mode", () => {
	expect(parsePlaceholder("{{D:F12:label}}")).toEqual({ id: "F12", kind: "F", label: "label", mode: "full", claimKind: "derived" })
})

test("legacy initialization retains the existing manifest clock field", () => {
	const manifest = initManifest({ sessionDir: "/nonexistent/20260101-120000", promised: [], lane: null })
	expect(validateOutcomeManifest(manifest)).toEqual({ ok: true, errors: [] })
})
