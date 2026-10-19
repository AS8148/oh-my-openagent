import { describe, expect, test } from "bun:test"

import { EN_QUOTE, HANGUL, inSentence, KO_QUOTE, source, stripEnd } from "./consent-corpus.shapes"
import REVIEW_ROW_CLASSES from "./consent-corpus.review-rows.classes.json"
import REVIEW_ROWS from "./consent-corpus.review-rows.json"

// Rows extracted mechanically from every review receipt of #10498 (scripts/extract-consent-corpus.ts; append-only). As a
// later sentence every row is a suggestion by the whole-message rule alone, so that shape proves nothing. Each row is instead
// classified by hand in consent-corpus.review-rows.classes.json and asserted where the whole-message rule does NOT
// decide, because the quote is the whole message:
// - retraction: inside the quoted words (the quote is the whole message), must stay a suggestion;
// - question-lead: opening the quoted instruction, must stay a suggestion;
// - message-agent / message-user: the row is a whole user message quoted whole, a suggestion / the user's;
// - lead-user: opening the quoted instruction, must stay the user's;
// - closer: a courtesy closer after the instruction, must stay the user's;
// - fragment: a code identifier, regex piece or prose quote, not a user phrase; no assertion.
// A new extracted row fails the first test until someone classifies it.
type RowClass = "retraction" | "question-lead" | "message-agent" | "message-user" | "lead-user" | "closer" | "fragment"
const ROW_CLASSES: Readonly<Record<string, string>> = REVIEW_ROW_CLASSES
const rowsOf = (kind: RowClass): string[] => REVIEW_ROWS.map((row) => row.phrase).filter((phrase) => ROW_CLASSES[phrase] === kind)

describe("consent corpus: every phrase any review quoted", () => {
  test("every extracted row is classified", () => {
    expect(REVIEW_ROWS.map((row) => row.phrase).filter((phrase) => ROW_CLASSES[phrase] === undefined)).toEqual([])
  })
  test.each(rowsOf("retraction"))("retraction %p inside the quoted words stays a suggestion", (phrase) => {
    const said = inSentence(phrase)
    expect(source(said, stripEnd(said))).toBe("agent")
  })
  test.each(rowsOf("question-lead"))("%p opening the instruction stays a suggestion", (phrase) => {
    const said = `${phrase} remove plugins X and Y`
    expect(source(said, said)).toBe("agent")
  })
  test.each(rowsOf("message-agent"))("%p quoted whole stays a suggestion", (phrase) => {
    expect(stripEnd(phrase).split(" ").length).toBeGreaterThanOrEqual(3)
    expect(source(phrase, stripEnd(phrase))).toBe("agent")
  })
  test.each(rowsOf("message-user"))("%p quoted whole stays the user's", (phrase) => {
    expect(source(phrase, stripEnd(phrase))).toBe("user")
  })
  test.each(rowsOf("lead-user"))("%p opening the instruction stays the user's", (phrase) => {
    const said = HANGUL.test(phrase) ? `${phrase} ${KO_QUOTE}` : `${phrase} remove plugins X and Y`
    expect(source(said, said)).toBe("user")
  })
  test.each(rowsOf("closer"))("instruction followed by closer %p stays the user's", (phrase) => {
    const [instruction, quote] = HANGUL.test(phrase) ? [KO_QUOTE, KO_QUOTE] : [EN_QUOTE, EN_QUOTE]
    expect(source(`${instruction} ${phrase}`, quote)).toBe("user")
  })
})

