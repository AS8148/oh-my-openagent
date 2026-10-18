import { describe, expect, test } from "bun:test"

import {
  claimReceiptTrailers,
  resolveClaimReceipt,
} from "./claim"

const USER_TEXTS = ["Please look at the WordPress plugins and tell me which ones look unused."]

describe("claim receipts", () => {
  test("#given a user claim whose quote appears in a user message #when resolved #then it keeps the user source and the quote", () => {
    const receipt = resolveClaimReceipt({ source: "user", userQuote: "tell me which ones look unused" }, USER_TEXTS)
    expect(receipt).toEqual({ source: "user", userQuote: USER_TEXTS[0] })
  })

  test("#given the #10488 flip: a user claim quoting the agent's own suggestion #when resolved #then it is downgraded to an agent suggestion", () => {
    const receipt = resolveClaimReceipt({ source: "user", userQuote: "remove plugins X and Y" }, USER_TEXTS)
    expect(receipt).toEqual({ source: "agent", downgraded: true })
  })

  test("#given a quote cut out of a negation or a question #when resolved #then the receipt keeps the whole user sentence", () => {
    const negation = resolveClaimReceipt({ source: "user", userQuote: "delete the prod database" }, ["Don't delete the prod database yet. Ask me again tomorrow."])
    expect(negation).toEqual({ source: "user", userQuote: "Don't delete the prod database yet." })
    const question = resolveClaimReceipt({ source: "user", userQuote: "remove plugins X and Y" }, ["Should we remove plugins X and Y? I'm not sure."])
    expect(question).toEqual({ source: "user", userQuote: "Should we remove plugins X and Y?" })
  })

  test("#given a user claim with no quote #when resolved #then it is downgraded", () => {
    expect(resolveClaimReceipt({ source: "user" }, USER_TEXTS)).toEqual({ source: "agent", downgraded: true })
  })

  test("#given a quote that differs only in whitespace and case #when resolved #then it still matches", () => {
    const receipt = resolveClaimReceipt({ source: "user", userQuote: "  Tell me   which ones\nlook UNUSED " }, USER_TEXTS)
    expect(receipt.source).toBe("user")
  })

  test("#given a quote too short to identify the user's words #when resolved #then it is downgraded", () => {
    expect(resolveClaimReceipt({ source: "user", userQuote: "ok" }, ["ok"]).source).toBe("agent")
    expect(resolveClaimReceipt({ source: "user", userQuote: "look unused." }, USER_TEXTS).source).toBe("agent")
  })

  test("#given a two-word Korean quote #when resolved #then the word floor still applies", () => {
    expect(resolveClaimReceipt({ source: "user", userQuote: "플러그인 삭제해줘" }, ["그 플러그인 삭제해줘"]).source).toBe("agent")
  })

  test("#given a quote in a script written without spaces #when it is long enough #then the word floor does not apply", () => {
    expect(resolveClaimReceipt({ source: "user", userQuote: "このプラグインを削除して" }, ["じゃあこのプラグインを削除してください"]).source).toBe("user")
  })

  test("#given an agent or inferred claim #when resolved #then the source is kept and any quote is dropped", () => {
    expect(resolveClaimReceipt({ source: "agent", userQuote: "tell me which ones look unused" }, USER_TEXTS)).toEqual({ source: "agent" })
    expect(resolveClaimReceipt({ source: "inferred" }, USER_TEXTS)).toEqual({ source: "inferred" })
  })

  test("#given a missing or unknown source #when resolved #then it is inferred", () => {
    expect(resolveClaimReceipt({}, USER_TEXTS)).toEqual({ source: "inferred" })
    expect(resolveClaimReceipt({ source: "boss" }, USER_TEXTS)).toEqual({ source: "inferred" })
  })

  test("#given each receipt #when rendered as trailers #then source, quote and downgrade are single-line trailers", () => {
    expect(claimReceiptTrailers({ source: "user", userQuote: "a\nb" })).toEqual([
      "Omo-Claim-Source: user",
      "Omo-User-Quote: a b",
    ])
    expect(claimReceiptTrailers({ source: "agent", downgraded: true })).toEqual([
      "Omo-Claim-Source: agent",
      "Omo-Claim-Downgraded: unverified-user-quote",
    ])
  })

})
