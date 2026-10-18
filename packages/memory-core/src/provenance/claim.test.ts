import { describe, expect, test } from "bun:test"

import {
  claimReceiptTrailers,
  renderClaimReceipt,
  resolveClaimReceipt,
} from "./claim"

const USER_TEXTS = ["Please look at the WordPress plugins and tell me which ones look unused."]

describe("claim receipts", () => {
  test("#given a user claim whose quote appears in a user message #when resolved #then it keeps the user source and the quote", () => {
    const receipt = resolveClaimReceipt({ source: "user", userQuote: "tell me which ones look unused" }, USER_TEXTS)
    expect(receipt).toEqual({ source: "user", userQuote: "tell me which ones look unused" })
  })

  test("#given the #10488 flip: a user claim quoting the agent's own suggestion #when resolved #then it is downgraded to an agent suggestion", () => {
    const receipt = resolveClaimReceipt({ source: "user", userQuote: "remove plugins X and Y" }, USER_TEXTS)
    expect(receipt).toEqual({ source: "agent", downgraded: true })
    expect(renderClaimReceipt(receipt)).toContain("not a user decision")
  })

  test("#given a user claim with no quote #when resolved #then it is downgraded", () => {
    expect(resolveClaimReceipt({ source: "user" }, USER_TEXTS)).toEqual({ source: "agent", downgraded: true })
  })

  test("#given a quote that differs only in whitespace and width #when resolved #then it still matches", () => {
    const receipt = resolveClaimReceipt({ source: "user", userQuote: "  tell me   which ones\nlook unused " }, USER_TEXTS)
    expect(receipt.source).toBe("user")
  })

  test("#given a quote too short to identify the user's words #when resolved #then it is downgraded", () => {
    expect(resolveClaimReceipt({ source: "user", userQuote: "ok" }, ["ok"]).source).toBe("agent")
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
