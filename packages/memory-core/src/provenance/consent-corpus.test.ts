import { describe, expect, test } from "bun:test"

import { resolveClaimReceipt } from "./claim"

// One corpus for the consent rule (#10488): every refusal, retraction, hedge and question found across all review rounds
// plus common everyday forms, and the plain follow-ups that must stay the user's. A change to consent.ts that drops a
// phrase fails here by name, so a fix for one round can never silently undo another.

const EN_INSTRUCTION = "Remove plugins X and Y."
const EN_QUOTE = "remove plugins X and Y"
const KO_INSTRUCTION = "플러그인 X 지워."
const KO_QUOTE = "플러그인 X 지워"

const EN_FOLLOWING_RETRACTIONS = [
  "No.", "Nope.", "Nooo.", "Don't.", "Please don't.", "Not yet.", "Never mind.", "Nevermind.", "Nvm.", "Hold on.", "Wait.",
  "Cancel that.", "Scratch that.", "Just kidding.", "jk", "Forget it.", "Ignore that.", "Disregard that.", "Undo that.",
  "Changed my mind.", "On second thought, keep them.", "Leave them.", "Actually no.", "I didn't mean that.", "Stop.",
  "Thanks. Never mind.",
]

const KO_FOLLOWING_RETRACTIONS = [
  "아니", "아니.", "아니요", "아니요.", "아니에요", "아니야", "아냐", "아닙니다", "아니라니까", "아니라고", "그건 아니고", "아뇨", "아뇨.",
  "아뇨 그건 두세요", "싫어", "싫어요", "싫다", "안 돼", "안돼", "하지 마", "하지 마세요", "취소", "됐어", "됐어요", "잠깐", "잠깐만",
  "잠시만", "기다려", "그만", "그만해", "멈춰", "ㄴㄴ", "노노", "냅둬", "놔둬", "그대로 둬", "없던 걸로 해", "스톱",
  "다시 생각해보니 그냥 둬",
]

const IN_SENTENCE_NON_CONSENT: readonly (readonly [string, string])[] = [
  ["Don't delete the prod database yet. Ask me again tomorrow.", "delete the prod database"],
  ["Don\u2019t delete the prod database yet.", "delete the prod database"],
  ["DON'T delete the prod database.", "delete the prod database"],
  ["Never delete the prod database.", "delete the prod database"],
  ["Should we remove plugins X and Y? I'm not sure.", "remove plugins X and Y"],
  ["Should I remove plugins X and Y", "remove plugins X and Y"],
  ["Can I remove plugins X and Y", "remove plugins X and Y"],
  ["Maybe remove plugins X and Y later.", "remove plugins X and Y"],
  ["remove plugins X and Y is a terrible idea.", "remove plugins X and Y"],
  ["You suggested remove plugins X and Y. No.", "remove plugins X and Y"],
  ["아직 플러그인 X 지우기는 하지 마", "플러그인 X 지우기"],
  ["플러그인 X 지워도 될까", "플러그인 X 지워도"],
  ["플러그인 X 지워도 될까요", "플러그인 X 지워도"],
  ["플러그인 X 지울지 고민중", "플러그인 X 지울지"],
  ["플러그인 X 지우지 말라고 했잖아", "플러그인 X 지우지"],
  ["플러그인 X 지우지 말 것", "플러그인 X 지우지"],
  ["플러그인 X 지우지 맙시다", "플러그인 X 지우지"],
]

const EN_FOLLOWING_MUST_STAY = [
  "Thanks.", "Also update plugin Z.", "Also run the tests.", "Then push it.", "Do it now.", "Thanks. Then push it.",
  "Nobody uses them.", "Notably, they are unused.",
]

const KO_FOLLOWING_MUST_STAY = [
  "고마워", "그리고 Y도 정리해", "끝나면 알려줘", "안에 있는 것도 지워", "일단 그거부터 해", "아니면 Y도 지워",
  "X가 아니라 Y도 같이 지워", "백업은 이미 완료됐어", "그만큼 중요해",
]

const AFFIRMATIVE_MUST_STAY: readonly (readonly [string, string])[] = [
  ["Please remove plugins X and Y now.", "remove plugins X and Y"],
  ["플러그인 X 지워줘", "플러그인 X 지워줘"],
  ["플러그인 X 지워 주세요", "플러그인 X 지워"],
  ["じゃあこのプラグインを削除してください", "このプラグインを削除して"],
]

const source = (said: string, quote: string): string => resolveClaimReceipt({ source: "user", userQuote: quote }, [said]).source

describe("consent corpus: these must stay a suggestion", () => {
  test.each(EN_FOLLOWING_RETRACTIONS)("English instruction followed by %p", (retraction) => {
    expect(source(`${EN_INSTRUCTION} ${retraction}`, EN_QUOTE)).toBe("agent")
  })
  test.each(KO_FOLLOWING_RETRACTIONS)("Korean instruction followed by %p", (retraction) => {
    expect(source(`${KO_INSTRUCTION} ${retraction}`, KO_QUOTE)).toBe("agent")
  })
  test.each(KO_FOLLOWING_RETRACTIONS)("Korean instruction followed by %p with no sentence mark", (retraction) => {
    expect(source(`${KO_QUOTE}\n${retraction}`, KO_QUOTE)).toBe("agent")
  })
  test.each(IN_SENTENCE_NON_CONSENT)("%p", (said, quote) => {
    expect(source(said, quote)).toBe("agent")
  })
})

describe("consent corpus: these must stay the user's", () => {
  test.each(EN_FOLLOWING_MUST_STAY)("English instruction followed by %p", (followUp) => {
    expect(source(`${EN_INSTRUCTION} ${followUp}`, EN_QUOTE)).toBe("user")
  })
  test.each(KO_FOLLOWING_MUST_STAY)("Korean instruction followed by %p", (followUp) => {
    expect(source(`${KO_INSTRUCTION} ${followUp}`, KO_QUOTE)).toBe("user")
  })
  test.each(AFFIRMATIVE_MUST_STAY)("%p", (said, quote) => {
    expect(source(said, quote)).toBe("user")
  })
})
