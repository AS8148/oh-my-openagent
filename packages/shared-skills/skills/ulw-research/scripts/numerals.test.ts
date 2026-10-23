import { describe, expect, test } from "bun:test"

import { CLAIMS, NOT_CLAIMS, NUM, parseNumeral, UNIT } from "./numerals.mjs"
import { normalizeUnit } from "./units.mjs"

describe("shared claim patterns", () => {
	test("exports the gate patterns", () => {
		expect(typeof NUM).toBe("string")
		expect(typeof UNIT).toBe("string")
		expect(NOT_CLAIMS.length).toBe(13)
		expect(CLAIMS.length).toBe(4)
	})
})

describe("parseNumeral", () => {
	test("a length with its unit", () => {
		expect(parseNumeral("320 m")).toEqual({ value: "320", raw: "320 m", span: [0, 5], unitRaw: "m", qualifierRaw: null })
		expect(parseNumeral("320 mm")?.unitRaw).toBe("mm")
	})

	test("thousands separators", () => {
		const parsed = parseNumeral("we shipped 1,237 units")
		expect(parsed?.value).toBe("1237")
		expect(parsed?.span).toEqual([11, 16])
	})

	test("Korean scale words fold into the value and leave the currency unit", () => {
		const parsed = parseNumeral("3억 원")
		expect(parsed?.value).toBe("300000000")
		expect(parsed?.raw).toBe("3억 원")
		expect(normalizeUnit(parsed?.unitRaw as string)).toBe(normalizeUnit("원"))
		expect(parseNumeral("4조 2,000억 원")?.value).toBe("4200000000000")
		expect(parseNumeral("3천만 원")?.value).toBe("30000000")
	})

	test("Latin suffixes and scale words", () => {
		expect(parseNumeral("1.2k")?.value).toBe("1200")
		expect(parseNumeral("$3M")).toMatchObject({ value: "3000000", raw: "$3M", unitRaw: "$" })
		expect(parseNumeral("2.5bn")?.value).toBe("2500000000")
		expect(parseNumeral("$4B")?.value).toBe("4000000000")
		expect(parseNumeral("3 million users")?.value).toBe("3000000")
		expect(parseNumeral("5 km")).toMatchObject({ value: "5", unitRaw: "km" })
	})

	test("percent and percentage points stay distinct", () => {
		expect(parseNumeral("15.2%")).toMatchObject({ value: "15.2", unitRaw: "%" })
		expect(parseNumeral("2%p")).toMatchObject({ value: "2", unitRaw: "%p" })
	})

	test("long decimals keep every digit", () => {
		expect(parseNumeral("10000000000000000.1")?.value).toBe("10000000000000000.1")
	})

	test("English number words one to twelve only", () => {
		expect(parseNumeral("three engineers")?.value).toBe("3")
		expect(parseNumeral("Twelve")?.value).toBe("12")
		expect(parseNumeral("thirteen")).toBeNull()
	})

	test("qualifiers before and after the value", () => {
		expect(parseNumeral("최대 4조 2,000억 원")).toMatchObject({ value: "4200000000000", qualifierRaw: "최대", span: [3, 14] })
		expect(parseNumeral("up to 320 m")?.qualifierRaw).toBe("up to")
		expect(parseNumeral("320 m 이상")?.qualifierRaw).toBe("이상")
		expect(parseNumeral("the 320 m mast")?.qualifierRaw).toBeNull()
	})

	test("dates, versions and figure references are not numerals", () => {
		expect(parseNumeral("v2.3.1")).toBeNull()
		expect(parseNumeral("see figure 3")).toBeNull()
		expect(parseNumeral("2026-10-23")).toBeNull()
		expect(parseNumeral("v2.3.1 shipped 40 fixes")?.value).toBe("40")
	})

	test("from skips earlier numerals", () => {
		const text = "320 m and 15%"
		const first = parseNumeral(text)
		expect(parseNumeral(text, first?.span[1])).toMatchObject({ value: "15", unitRaw: "%" })
		expect(parseNumeral("no numbers here")).toBeNull()
	})
})
