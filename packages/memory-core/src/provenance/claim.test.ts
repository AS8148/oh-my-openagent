import { describe, expect, test } from "bun:test"

import {
  claimReceiptTrailers,
  resolveClaimReceipt,
  USER_QUOTE_RULE,
} from "./claim"

const USER_TEXTS = ["Please look at the WordPress plugins and tell me which ones look unused."]

describe("claim receipts", () => {
  test("#given a user claim quoting the user's whole message #when resolved #then it keeps the user source and the message", () => {
    const receipt = resolveClaimReceipt({ source: "user", userQuote: "look at the WordPress plugins and tell me which ones look unused" }, USER_TEXTS)
    expect(receipt).toEqual({ source: "user", userQuote: USER_TEXTS[0] })
  })

  test("#given a quote of only part of the user's message #when resolved #then it stays a suggestion", () => {
    expect(resolveClaimReceipt({ source: "user", userQuote: "tell me which ones look unused" }, USER_TEXTS)).toEqual({ source: "agent", downgraded: true })
  })

  test("#given the #10488 flip: a user claim quoting the agent's own suggestion #when resolved #then it is downgraded to an agent suggestion", () => {
    const receipt = resolveClaimReceipt({ source: "user", userQuote: "remove plugins X and Y" }, USER_TEXTS)
    expect(receipt).toEqual({ source: "agent", downgraded: true })
  })

  test.each([
    ["a negation", "delete the prod database", "Don't delete the prod database yet. Ask me again tomorrow."],
    ["a question", "remove plugins X and Y", "Should we remove plugins X and Y? I'm not sure."],
    ["a qualifier", "remove plugins X and Y", "Maybe remove plugins X and Y later."],
    ["a Korean negation", "플러그인 X 지우기", "아직 플러그인 X 지우기는 하지 마"],
    ["a Korean question", "플러그인 X 지워도", "플러그인 X 지워도 될까"],
    ["a curly-apostrophe negation", "delete the prod database", "Don\u2019t delete the prod database yet."],
    ["a polite Korean question", "플러그인 X 지워도", "플러그인 X 지워도 될까요"],
    ["a Korean deliberation", "플러그인 X 지울지", "플러그인 X 지울지 고민중"],
    ["a first-person question without a mark", "remove plugins X and Y", "Should I remove plugins X and Y"],
    ["an objection after the quote", "remove plugins X and Y", "remove plugins X and Y is a terrible idea."],
    ["an English refusal in the next sentence", "remove plugins X and Y", "Remove plugins X and Y. No."],
    ["a Korean refusal in the next sentence", "플러그인 X 지워", "플러그인 X 지워. 아니."],
    ["a Korean refusal with no punctuation", "플러그인 X 지워", "플러그인 X 지워. 아니요"],
    ["a polite Korean refusal", "플러그인 X 지워", "플러그인 X 지워. 싫어요"],
    ["a Korean wait", "플러그인 X 지워", "플러그인 X 지워. 잠깐"],
    ["a Korean reported prohibition", "플러그인 X 지우지", "플러그인 X 지우지 말라고 했잖아"],
    ["a Korean written prohibition", "플러그인 X 지우지", "플러그인 X 지우지 말 것"],
  ])("#given a quote cut out of %s #when resolved #then it stays a suggestion", (_case, quote, said) => {
    expect(resolveClaimReceipt({ source: "user", userQuote: quote }, [said])).toEqual({ source: "agent", downgraded: true })
  })

  test.each([
    "아니야", "아냐", "잠깐만", "그만해", "됐어요", "하지 마세요", "아닙니다", "아니에요", "안 돼", "안돼", "싫다", "취소", "멈춰", "아니라니까",
    "아뇨", "아뇨.", "아뇨 그건 두세요", "잠시만", "기다려", "ㄴㄴ", "노노", "냅둬", "놔둬", "그대로 둬", "없던 걸로 해", "스톱", "다시 생각해보니 그냥 둬", "됐어",
  ])("#given a Korean retraction %s in the next sentence #when resolved #then it stays a suggestion", (retraction) => {
    expect(resolveClaimReceipt({ source: "user", userQuote: "플러그인 X 지워" }, [`플러그인 X 지워. ${retraction}`]))
      .toEqual({ source: "agent", downgraded: true })
  })

  test.each([
    "Not yet.", "Never mind.", "Nevermind.", "Hold on.", "Cancel that.", "Scratch that.", "Please don't.", "Just kidding.", "Nooo.",
    "Forget it.", "Nvm.", "Ignore that.", "Disregard that.", "Undo that.", "Changed my mind.", "On second thought, keep them.", "Leave them.", "jk", "Thanks. Never mind.",
  ])("#given an English retraction %s in the next sentence #when resolved #then it stays a suggestion", (retraction) => {
    expect(resolveClaimReceipt({ source: "user", userQuote: "remove plugins X and Y" }, [`Remove plugins X and Y. ${retraction}`]))
      .toEqual({ source: "agent", downgraded: true })
  })

  test.each([
    ["Remove plugins X and Y. Also update plugin Z.", "remove plugins X and Y"],
    ["플러그인 X 지워. 그리고 Y도 정리해", "플러그인 X 지워"],
    ["플러그인 X 지우지 맙시다", "플러그인 X 지우지"],
    ["플러그인 X 지워. 일단 그거부터 해", "플러그인 X 지워"],
    ["플러그인 X 지워. 아니면 Y도 지워", "플러그인 X 지워"],
    ["플러그인 X 지워. 백업은 이미 완료됐어", "플러그인 X 지워"],
    ["플러그인 X 지워. 그만큼 중요해", "플러그인 X 지워"],
    ["플러그인 X 지워. 안에 있는 것도 지워", "플러그인 X 지워"],
    ["Remove plugins X and Y. Thanks. Then push it.", "remove plugins X and Y"],
  ])("#given %s #when resolved #then any later sentence (or a written prohibition) leaves it a suggestion", (said, quote) => {
    expect(resolveClaimReceipt({ source: "user", userQuote: quote }, [said]).source).toBe("agent")
  })

  test("#given the whole message apart from courtesy closers #when resolved #then the receipt stores the whole message", () => {
    expect(resolveClaimReceipt({ source: "user", userQuote: "remove plugins X and Y now" }, ["Thanks please remove plugins X and Y now."]))
      .toEqual({ source: "user", userQuote: "Thanks please remove plugins X and Y now." })
  })

  test("#given a user claim with no quote #when resolved #then it is downgraded", () => {
    expect(resolveClaimReceipt({ source: "user" }, USER_TEXTS)).toEqual({ source: "agent", downgraded: true })
  })

  test("#given a quote that differs only in whitespace and case #when resolved #then it still matches", () => {
    const receipt = resolveClaimReceipt({ source: "user", userQuote: "  Please LOOK at the WordPress plugins and tell me   which ones\nlook UNUSED " }, USER_TEXTS)
    expect(receipt.source).toBe("user")
  })

  test("#given a short whole message #when quoted whole #then it verifies, and a short fragment does not", () => {
    expect(resolveClaimReceipt({ source: "user", userQuote: "응 해줘" }, ["응 해줘"]).source).toBe("user")
    expect(resolveClaimReceipt({ source: "user", userQuote: "yes do it" }, ["Yes do it!"]).source).toBe("user")
    expect(resolveClaimReceipt({ source: "user", userQuote: "look unused." }, USER_TEXTS).source).toBe("agent")
    expect(resolveClaimReceipt({ source: "user", userQuote: "플러그인 삭제해줘" }, ["그 플러그인 삭제해줘"]).source).toBe("agent")
  })

  test("#given a quote that is only punctuation or a closer #when resolved #then it is downgraded", () => {
    expect(resolveClaimReceipt({ source: "user", userQuote: "Thanks!" }, ["Thanks!"]).source).toBe("agent")
    expect(resolveClaimReceipt({ source: "user", userQuote: "..." }, ["..."]).source).toBe("agent")
  })

  test("#given a script outside Latin and Hangul #when quoted whole or in part #then it is never auto-verified", () => {
    expect(resolveClaimReceipt({ source: "user", userQuote: "じゃあこのプラグインを削除してください" }, ["じゃあこのプラグインを削除してください"]).source).toBe("agent")
    expect(resolveClaimReceipt({ source: "user", userQuote: "このプラグインを削除して" }, ["じゃあこのプラグインを削除してください"]).source).toBe("agent")
  })

  test("#given an agent or inferred claim #when resolved #then the source is kept and any quote is dropped", () => {
    expect(resolveClaimReceipt({ source: "agent", userQuote: USER_TEXTS[0] }, USER_TEXTS)).toEqual({ source: "agent" })
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

  test("#given the facts extractor persona #when shipped #then it states the same user_quote rule the verifier enforces", async () => {
    const persona = await Bun.file(new URL("../facts/assets/facts-persona.md", import.meta.url)).text()
    expect(persona).toContain(USER_QUOTE_RULE)
  })
})
