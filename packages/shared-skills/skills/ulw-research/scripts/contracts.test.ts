import { describe, expect, test } from "bun:test"

import {
	ANSWERED_BY,
	DEFECT_CODES,
	DELIVERABLE_FORMATS,
	DELIVERABLE_STATUSES,
	DESIGN_SPEC_SECTIONS,
	FIDELITY_CODES,
	GATE_NAMES,
	GATE_STATUSES,
	INTEGRITY_CODES,
	LANES,
	LAYOUT_CODES,
	LINEAGE_MODES,
	MANIFEST_CODES,
	REPAIR_DEFAULTS,
	STATES,
	STATIC_CODES,
} from "./contracts.mjs"

const SEVERITIES = new Set(["blocker", "major", "minor"])
const STATIC_CODES_EXPECTED = [
	"korean_no_keep_all",
	"palette_off_token",
	"emoji_in_prose",
	"em_dash_in_prose",
	"en_dash_in_prose",
	"heading_too_long",
	"heading_generic",
	"unsourced_number",
	"chart_without_figure",
	"chart_svg_no_text",
	"chart_svg_missing_labels",
	"report_without_visual",
	"image_missing_alt",
	"korean_serif_font",
	"section_without_citation",
	"missing_closing_section",
	"missing_citation_section",
	"broken_asset_reference",
	"missing_required_section",
]
const LAYOUT_CODES_EXPECTED = [
	"layout_overflow",
	"layout_text_clipped",
	"layout_scroll_container",
	"layout_image_distorted",
	"layout_sibling_overlap",
]
// Fidelity vocabulary contract (#11009): severity and integrity per code are fixed here.
const FIDELITY_BLOCKERS = [
	"unresolved_placeholder",
	"value_mismatch",
	"unit_mismatch",
	"quote_not_verbatim",
	"claim_status_invalid",
	"incompatible_operands",
	"pointer_label_mismatch",
	"quote_anchor_unresolved",
	"unit_duplicated",
	"polish_diff_fail",
	"fidelity_interview_incomplete",
	"derived_not_allowed",
	"source_outside_floor",
	"brief_changed",
	"snapshot_hash_mismatch",
	"snapshot_not_raw",
	"chart_value_untraceable",
	"quote_unbound",
	"edition_unverified",
]
const FIDELITY_MAJORS = [
	"untraceable_number",
	"unsupported_verification",
	"claim_kind_mismatch",
	"conflicting_readings",
	"hedge_dropped",
	"direction_flipped",
	"causality_added",
	"qualifier_dropped",
	"unbound_sentence",
	"meaning_drift_confirmed",
	"meaning_unverified",
	"polish_edit_rejected",
	"polish_hedging_decreased",
	"polish_text_churn",
	"snapshot_mismatch",
	"join_integrity_fail",
	"quote_stale_version",
]
const FIDELITY_MINORS = [
	"quote_fuzzy_match",
	"relocated",
	"name_outside_quote",
	"verification_claim_unmarked",
	"scope_widened_warn",
	"particle_unverified",
	"fallback_without_entity",
	"meaning_drift_warn",
	"polish_edit_unlocated",
	"polish_link_changed",
	"polish_name_changed",
]
const FIDELITY_CODES_EXPECTED = [...FIDELITY_BLOCKERS, ...FIDELITY_MAJORS, ...FIDELITY_MINORS]
describe("DEFECT_CODES", () => {
	test("#given the code table #when every code is inspected #then it has a severity, a hint, and an integrity flag", () => {
		expect(Object.keys(DEFECT_CODES).sort()).toEqual(
			[...STATIC_CODES_EXPECTED, "missing_promised_deliverable", ...LAYOUT_CODES_EXPECTED, ...FIDELITY_CODES_EXPECTED].sort(),
		)
		for (const [code, entry] of Object.entries(DEFECT_CODES)) {
			expect(SEVERITIES.has(entry.severity), `${code} severity`).toBe(true)
			expect(typeof entry.hint).toBe("string")
			expect(entry.hint.length).toBeGreaterThan(10)
			expect(typeof entry.integrity).toBe("boolean")
		}
	})

	test("#given the code table #when integrity codes are derived #then they are exactly the blocker codes", () => {
		expect([...INTEGRITY_CODES].sort()).toEqual(
			[
				"broken_asset_reference",
				"missing_citation_section",
				"missing_closing_section",
				"missing_promised_deliverable",
				"missing_required_section",
				...FIDELITY_BLOCKERS,
			].sort(),
		)
		for (const code of INTEGRITY_CODES) expect(DEFECT_CODES[code].severity).toBe("blocker")
		for (const [code, entry] of Object.entries(DEFECT_CODES)) {
			if (entry.severity === "blocker") expect(INTEGRITY_CODES.has(code), `${code} must be integrity`).toBe(true)
		}
	})

	test("#given the frozen table #when a severity write is attempted #then it throws and the value is unchanged", () => {
		expect(Object.isFrozen(DEFECT_CODES)).toBe(true)
		expect(Object.isFrozen(DEFECT_CODES.korean_no_keep_all)).toBe(true)
		expect(() => {
			"use strict"
			DEFECT_CODES.korean_no_keep_all.severity = "minor"
		}).toThrow()
		expect(DEFECT_CODES.korean_no_keep_all.severity).toBe("major")
	})

	test("#given the fidelity codes #when inspected #then each carries its fixed severity and integrity flag", () => {
		for (const code of FIDELITY_BLOCKERS) expect([code, DEFECT_CODES[code]?.severity, DEFECT_CODES[code]?.integrity]).toEqual([code, "blocker", true])
		for (const code of FIDELITY_MAJORS) expect([code, DEFECT_CODES[code]?.severity, DEFECT_CODES[code]?.integrity]).toEqual([code, "major", false])
		for (const code of FIDELITY_MINORS) expect([code, DEFECT_CODES[code]?.severity, DEFECT_CODES[code]?.integrity]).toEqual([code, "minor", false])
		expect(DEFECT_CODES).not.toHaveProperty("incompatible_populations")
	})
})

describe("code groups", () => {
	test("#given the code groups #when unioned #then they partition the code table exactly", () => {
		expect([...STATIC_CODES].sort()).toEqual(STATIC_CODES_EXPECTED.slice().sort())
		expect([...LAYOUT_CODES].sort()).toEqual(LAYOUT_CODES_EXPECTED.slice().sort())
		expect([...MANIFEST_CODES]).toEqual(["missing_promised_deliverable"])
		expect([...FIDELITY_CODES].sort()).toEqual(FIDELITY_CODES_EXPECTED.slice().sort())
		const union = [...STATIC_CODES, ...LAYOUT_CODES, ...MANIFEST_CODES, ...FIDELITY_CODES].sort()
		expect(union).toEqual(Object.keys(DEFECT_CODES).sort())
		expect(new Set(union).size).toBe(union.length)
		expect(Object.isFrozen(STATIC_CODES)).toBe(true)
		expect(Object.isFrozen(FIDELITY_CODES)).toBe(true)
	})
})

describe("enums", () => {
	test("#given the vocabulary #when read #then lanes, states, formats, statuses, gates, lineage modes are fixed lists", () => {
		expect(LANES).toEqual(["template-strict", "template-vibe", "no-format", "edit-existing"])
		expect(STATES).toEqual(["none", "partial", "complete"])
		expect(DELIVERABLE_FORMATS).toEqual(["pdf", "docx", "html", "md", "latex", "slides", "post"])
		expect(DELIVERABLE_STATUSES).toEqual(["pending", "delivered", "blocked_capability", "skipped", "failed"])
		expect(GATE_NAMES).toEqual(["static", "fidelity", "layout", "visual", "proofread"])
		expect(ANSWERED_BY).toEqual(["user", "default", "request", "pending"])
		expect(GATE_STATUSES).toEqual(["pass", "fail", "not_run"])
		expect(LINEAGE_MODES).toEqual(["inline", "section"])
		expect(DESIGN_SPEC_SECTIONS).toEqual([
			"Extracted from", "Tokens", "Typography", "Layout", "Structure", "Figures", "Citations", "Open questions",
		])
		expect(REPAIR_DEFAULTS).toEqual({ maxAttempts: 3, plateauLimit: 2, wallClockMs: 900_000 })
		expect(Object.isFrozen(LANES)).toBe(true)
		expect(Object.isFrozen(REPAIR_DEFAULTS)).toBe(true)
	})
})
