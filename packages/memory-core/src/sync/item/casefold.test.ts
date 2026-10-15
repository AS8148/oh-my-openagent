import { describe, expect, test } from "bun:test"

import { caseFold } from "./index"

describe("caseFold (vendored Unicode 16.0 full folding)", () => {
  test("folds ASCII", () => {
    expect(caseFold("Notes.MD")).toBe("notes.md")
    expect(caseFold("")).toBe("")
  })

  test("full folds can lengthen the string: ß and ligatures", () => {
    expect(caseFold("Straße")).toBe("strasse")
    expect(caseFold("ﬀ")).toBe("ff")
    expect(caseFold("ﬁles")).toBe("files")
  })

  test("Turkic dotted İ uses the locale-independent full fold", () => {
    expect(caseFold("İ")).toBe("i̇")
    expect(caseFold("İSTANBUL")).toBe("i̇stanbul")
  })

  test("dotless ı and plain I fold independently of the runtime ICU", () => {
    expect(caseFold("ı")).toBe("ı")
    expect(caseFold("I")).toBe("i")
  })

  test("Greek sigma: capital and final forms share one fold", () => {
    expect(caseFold("Σ")).toBe("σ")
    expect(caseFold("ς")).toBe("σ")
    expect(caseFold("ΟΔΗΓΟΣ")).toBe("οδηγοσ")
    expect(caseFold("οδηγός")).toBe("οδηγοσ")
  })

  test("folds above the BMP by code point", () => {
    expect(caseFold("𐐀")).toBe("𐐨")
    expect(caseFold("𐐀𐐨")).toBe("𐐨𐐨")
  })

  test("folds Cherokee lowercase additions from Unicode 8+", () => {
    expect(caseFold("ᏸ")).toBe("ꮸ")
  })

  test("is case-only: it never normalizes or strips marks", () => {
    expect(caseFold("café")).toBe("café")
    expect(caseFold("á")).toBe("á")
    expect(caseFold("한글")).toBe("한글")
  })

  test("is stable: folding twice changes nothing", () => {
    const samples = ["Straße", "İSTANBUL", "ΟΔΗΓΟΣ", "𐐀", "Notes.MD", "ᏸ"]
    for (const s of samples) expect(caseFold(caseFold(s))).toBe(caseFold(s))
  })
})
