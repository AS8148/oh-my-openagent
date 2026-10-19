import { describe, expect, test } from "bun:test"

import { EN_INSTRUCTION, EN_QUOTE, inSentence, KO_INSTRUCTION, KO_QUOTE, source, stripEnd } from "./consent-corpus.shapes"

// One corpus for the consent rule (#10488): every refusal, retraction, hedge and question found across all review rounds
// plus common everyday forms, and the plain follow-ups that must stay the user's. A change to consent.ts that drops a
// phrase fails here by name, so a fix for one round can never silently undo another.

const EN_FOLLOWING_RETRACTIONS = [
  "No.", "Nope.", "Nooo.", "Don't.", "Please don't.", "Not yet.", "Never mind.", "Nevermind.", "Nvm.", "Hold on.", "Wait.",
  "Cancel that.", "Scratch that.", "Just kidding.", "jk", "Forget it.", "Ignore that.", "Disregard that.", "Undo that.",
  "Changed my mind.", "On second thought, keep them.", "Leave them.", "Actually no.", "I didn't mean that.", "Stop.",
  "Thanks. Never mind.", "Hang on.", "Hold up.", "One sec.", "Forget that.", "Forget about it.", "Scrap that.", "Strike that.",
  "Ignore it.", "Ignore me.", "Ignore my last message.", "Keep them.", "Abort.", "Revert that.", "Skip it.", "Drop it.",
]

const KO_FOLLOWING_RETRACTIONS = [
  "아니", "아니.", "아니요", "아니요.", "아니에요", "아니야", "아냐", "아닙니다", "아니라니까", "아니라고", "그건 아니고", "아뇨", "아뇨.",
  "아뇨 그건 두세요", "싫어", "싫어요", "싫다", "안 돼", "안돼", "하지 마", "하지 마세요", "취소", "됐어", "됐어요", "잠깐", "잠깐만",
  "잠시만", "기다려", "그만", "그만해", "멈춰", "ㄴㄴ", "노노", "냅둬", "놔둬", "그대로 둬", "없던 걸로 해", "스톱",
  "다시 생각해보니 그냥 둬", "그냥 둬", "그냥 두세요", "두세요", "필요 없어", "그럴 필요 없어", "관둬", "관두자", "농담이야", "장난이야",
  "되돌려", "원래대로 해", "다음에 하자", "아직이야", "안할래", "놉", "패스", "아니라잖아", "아니라니깐", "그게 아니라", "됐다니까",
  "됐거든", "됐습니다", "됐네",
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

// Any sentence after the quote, even a friendly one, leaves the claim a suggestion: the quote must be the user's last word.
const COURTESY_CLOSERS = ["Thanks.", "Thanks", "Thank you.", "Thank you!", "고마워", "고마워.", "감사합니다", "감사합니다.", "부탁해", "부탁해!"]

const FOLLOW_UPS_OF_ANY_KIND = [
  "Thanks. Then push it.", "Also update plugin Z.", "Also run the tests.", "Do it now.", "Nobody uses them.", "Notably, they are unused.",
  "안에 있는 것도 지워", "일단 그거부터 해", "아니면 Y도 지워", "X가 아니라 Y도 같이 지워", "백업은 이미 완료됐어", "그만큼 중요해",
  "고마워요", "부탁해요", "감사해요", "Thanks a lot.", "Then push it.", "No rush.", "No worries.", "Don't forget to run the tests.",
  "그리고 Y도 정리해", "끝나면 알려줘", "백업 다 됐어", "준비 됐어", "잠시 후에 푸시해",
]

const AFFIRMATIVE_LAST_SENTENCE_MUST_STAY: readonly (readonly [string, string])[] = [
  ["Thanks. Remove plugins X and Y.", "remove plugins X and Y"],
  ["Nobody uses them, so remove plugins X and Y.", "remove plugins X and Y"],
  ["Notably unused: remove plugins X and Y.", "remove plugins X and Y"],
  ["고마워. 플러그인 X 지워", "플러그인 X 지워"],
  ["플러그인 X 아니면 Y를 지워", "아니면 Y를 지워"],
  ["X가 아니라 플러그인 Y를 지워", "플러그인 Y를 지워"],
  ["그만큼 쓸모없으니 플러그인 X 지워", "플러그인 X 지워"],
  ["안에 있는 플러그인 X 지워", "플러그인 X 지워"],
  ["일단 플러그인 X부터 지워", "플러그인 X부터 지워"],
]

const AFFIRMATIVE_MUST_STAY: readonly (readonly [string, string])[] = [
  ["Please remove plugins X and Y now.", "remove plugins X and Y"],
  ["플러그인 X 지워줘", "플러그인 X 지워줘"],
  ["플러그인 X 지워 주세요", "플러그인 X 지워"],
  ["じゃあこのプラグインを削除してください", "このプラグインを削除して"],
]

// A quote that crosses a sentence boundary must not skip the last-word rule (review of 0f4147b789, HIGH 1).
const SPANNING_QUOTES: readonly (readonly [string, string])[] = [
  ["Remove plugins X and Y. Then keep them.", "remove plugins X and Y. Then"],
  ["Remove plugins X and Y. Now. Okay keep them.", "plugins X and Y. Now"],
  ["Remove plugins X and Y. Now. Okay keep them.", "remove plugins X and Y. Now."],
  ["Remove plugins X and Y. Then leave them be.", "remove plugins X and Y. Then"],
  ["플러그인 X 지워. 그리고 그건 그대로", "플러그인 X 지워. 그리고"],
]

// A later CLAUSE counts like a later sentence: only a courtesy closer may follow the quote's clause.
const LATER_CLAUSES: readonly (readonly [string, string])[] = [
  ["Remove plugins X and Y, keep them.", "remove plugins X and Y"],
  ["Remove plugins X and Y, leave them be.", "remove plugins X and Y"],
  ["Remove plugins X and Y;keep them", "remove plugins X and Y"],
  ["플러그인 X 지워, 그건 그대로", "플러그인 X 지워"],
]

const CLOSER_CLAUSES: readonly (readonly [string, string])[] = [
  ["Remove plugins X and Y, thanks.", "remove plugins X and Y"],
  ["Please remove plugins X and Y now, thank you!", "remove plugins X and Y"],
  ["플러그인 X 지워, 고마워", "플러그인 X 지워"],
]

// 됐 is a retraction as an interjection (alone, opening a clause, or right after the instruction), and a plain past tense
// everywhere else (review of 0f4147b789, LOW on 됐, raised by the lead).
const DWAESS_STATEMENTS_MUST_STAY: readonly (readonly [string, string])[] = [
  ["서버 백업 다 됐어", "서버 백업 다 됐어"],
  ["백업은 이미 됐어", "백업은 이미 됐어"],
  ["준비 다 됐어요", "준비 다 됐어요"],
  ["백업 다 됐어 플러그인 X 지워", "백업 다 됐어 플러그인 X 지워"],
  ["백업은 이미 완료됐으니 플러그인 X 지워", "백업은 이미 완료됐으니 플러그인 X 지워"],
  ["백업 됐으면 플러그인 X 지워", "백업 됐으면 플러그인 X 지워"],
  ["완료됐어 이제 플러그인 X 지워", "완료됐어 이제 플러그인 X 지워"],
]

const DWAESS_RETRACTIONS: readonly (readonly [string, string])[] = [
  ["됐어", "됐어 그냥 그거"],
  ["됐어 그냥 그거", "됐어 그냥 그거"],
  ["플러그인 X 지워 됐어", "플러그인 X 지워 됐어"],
  ["플러그인 X 지워 아 됐어", "플러그인 X 지워 아 됐어"],
  ["플러그인 X 지워 그건 됐고", "플러그인 X 지워 그건 됐고"],
  ["플러그인 X 지워줘 됐다니까", "플러그인 X 지워줘 됐다니까"],
]

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
  test.each([...EN_FOLLOWING_RETRACTIONS, ...KO_FOLLOWING_RETRACTIONS])("retraction %p inside the quoted words", (retraction) => {
    const said = inSentence(retraction)
    expect(source(said, stripEnd(said))).toBe("agent")
  })
  test.each(KO_FOLLOWING_RETRACTIONS)("retraction %p right after the instruction with no mark, quoted whole", (retraction) => {
    const said = `${KO_QUOTE} ${retraction}`
    expect(source(said, stripEnd(said))).toBe("agent")
  })
  test.each(SPANNING_QUOTES)("quote spanning sentences: %p quoting %p", (said, quote) => {
    expect(source(said, quote)).toBe("agent")
  })
  test.each(LATER_CLAUSES)("later clause: %p", (said, quote) => {
    expect(source(said, quote)).toBe("agent")
  })
  test.each(DWAESS_RETRACTIONS)("됐 as a retraction: %p", (said, quote) => {
    expect(source(said, quote)).toBe("agent")
  })
})

describe("consent corpus: a quote followed by anything stays a suggestion", () => {
  test.each(FOLLOW_UPS_OF_ANY_KIND)("instruction followed by %p", (followUp) => {
    const [instruction, quote] = /[가-힣]/.test(followUp) ? [KO_INSTRUCTION, KO_QUOTE] : [EN_INSTRUCTION, EN_QUOTE]
    expect(source(`${instruction} ${followUp}`, quote)).toBe("agent")
  })
})

describe("consent corpus: the closed courtesy closers do not count as a later sentence", () => {
  test.each(COURTESY_CLOSERS)("instruction followed by %p", (closer) => {
    const [instruction, quote] = /[가-힣]/.test(closer) ? [KO_INSTRUCTION, KO_QUOTE] : [EN_INSTRUCTION, EN_QUOTE]
    expect(source(`${instruction} ${closer}`, quote)).toBe("user")
  })
})

describe("consent corpus: these must stay the user's", () => {
  test.each(AFFIRMATIVE_LAST_SENTENCE_MUST_STAY)("%p", (said, quote) => {
    expect(source(said, quote)).toBe("user")
  })
  test.each(AFFIRMATIVE_MUST_STAY)("%p", (said, quote) => {
    expect(source(said, quote)).toBe("user")
  })
  test.each(CLOSER_CLAUSES)("closer clause: %p", (said, quote) => {
    expect(source(said, quote)).toBe("user")
  })
  test.each(DWAESS_STATEMENTS_MUST_STAY)("됐 as a plain past tense: %p", (said, quote) => {
    expect(source(said, quote)).toBe("user")
  })
})
