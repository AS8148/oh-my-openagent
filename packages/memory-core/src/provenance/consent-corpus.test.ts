import { describe, expect, test } from "bun:test"

import { EN_INSTRUCTION, EN_QUOTE, inSentence, KO_INSTRUCTION, KO_QUOTE, source, stripEnd } from "./consent-corpus.shapes"

// Lead ruling on #10498: a "user said" receipt verifies only when the quote is the user's whole message (give or take
// spaces, case, one final '.' or '!' and the courtesy closers) AND that message uses only ASCII letters, Hangul syllables,
// ASCII digits, the ASCII space, an apostrophe between letters and one final '.' or '!'. Everything else fails closed.

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

// Everything the reviews found past a partial quote, plus the follow-ups of any kind: never verified.
const PARTIAL_QUOTES: readonly (readonly [string, string])[] = [
  ["Remove plugins X and Y just joking", EN_QUOTE],
  ["Remove plugins X and Y then put them back", EN_QUOTE],
  ["Remove plugins X and Y \u2014 reconsider that", EN_QUOTE],
  ["Remove plugins X and Y: I'm joking", EN_QUOTE],
  ["Remove plugins X and Y\u2026 put them back", EN_QUOTE],
  ["Remove plugins X and Y.Put them back", EN_QUOTE],
  ["Remove plugins X and Y, keep them.", EN_QUOTE],
  ["Remove plugins X and Y;keep them", EN_QUOTE],
  ["Remove plugins X and Y. Then keep them.", "remove plugins X and Y. Then"],
  ["Remove plugins X and Y. Now. Okay keep them.", "plugins X and Y. Now"],
  ["Please remove plugins X and Y now.", EN_QUOTE],
  ["플러그인 X 지워줘 했다가 다시 살려", "플러그인 X 지워줘"],
  ["플러그인 X 지워줘 아 근데 다시 넣어", "플러그인 X 지워줘"],
  ["플러그인 X 지워줘 생각해볼게", "플러그인 X 지워줘"],
  ["플러그인 X 지워줘 근데 됐어", "플러그인 X 지워줘"],
  ["플러그인 X 지워줘 ㅋ 됐어", "플러그인 X 지워줘"],
  ["플러그인 X 지워 주세요", KO_QUOTE],
  ["응 해줘?", "응 해줘"],
  ["yes do it?", "yes do it"],
  ["ok \u{1f44e}", "ok"],
  ["ok \u{1f645}", "ok"],
]

// One test per character class the allowlist refuses; each message is quoted whole.
const REFUSED_CHARACTER_CLASSES: readonly (readonly [string, string])[] = [
  ["a question mark", "remove plugins X and Y?"],
  ["a non-ASCII question mark", "Delete the prod database \u2e2e"],
  ["a comma", "Yes, do it!"],
  ["a run of commas", "플러그인 X 지워,,,"],
  ["a period inside the message", "Thanks. Remove plugins X and Y."],
  ["a repeated final mark", "Remove plugins X and Y!!"],
  ["an ellipsis", "Delete the prod database..."],
  ["a colon", "Do it now: remove plugins X and Y"],
  ["a tilde", "응 해줘~"],
  ["a modifier-letter apostrophe", "Don\u02bct delete the prod database"],
  ["a turned-comma apostrophe", "Don\u02bbt delete it"],
  ["a saltillo apostrophe", "Don\ua78ct delete it"],
  ["a curly apostrophe", "Don\u2019t delete the prod database"],
  ["a full-width apostrophe", "Don\uff07t delete it"],
  ["a backtick", "Don`t delete it"],
  ["an acute accent", "Don\u00b4t delete it"],
  ["an apostrophe at the start of a word", "Don 't delete it"],
  ["an apostrophe at the end of a word", "Don' t delete it"],
  ["a Cyrillic look-alike", "D\u043en't delete it"],
  ["a Japanese message", "じゃあこのプラグインを削除してください"],
  ["a Han character", "删除插件"],
  ["consonant jamo laughter", "ㅋㅋㅋ"],
  ["a laughing tail", "플러그인 X 지워 ㅋㅋ"],
  ["consonant jamo ok", "ㅇㅇ 해줘"],
  ["a lone no jamo", "ㄴ 지워"],
  ["vowel jamo crying", "ㅠㅠ"],
  ["an arae-a ellipsis", "플러그인 X 지워\u318d\u318d"],
  ["an emoji", "Delete the prod database \u{1f914}"],
  ["a zero-width space", "Remove plugins\u200b X and Y"],
  ["a combining grapheme joiner", "Don\u034f't delete the prod database"],
  ["a variation selector", "Do\ufe0fn't delete it"],
  ["a combining overlay", "n\u0337o delete it"],
  ["a Hangul filler", "Do\u3164n't delete it"],
  ["a full-width letter", "\uff52emove plugins X and Y"],
  ["a newline", "Remove plugins X\nand Y"],
  ["a tab", "Remove plugins X\tand Y"],
  ["an ideographic stop", "Remove plugins X and Y\u3002"],
]

// The word scan still refuses a verifiable message that is itself a refusal, hedge or question.
const WHOLE_MESSAGE_NON_CONSENT = [
  "Don't delete the prod database yet.", "DON'T delete the prod database.", "Never delete the prod database.",
  "Should I remove plugins X and Y", "Can I remove plugins X and Y", "Maybe remove plugins X and Y later.",
  "remove plugins X and Y is a terrible idea.", "Do n't delete the prod database", "아직 플러그인 X 지우기는 하지 마",
  "플러그인 X 지워도 될까", "플러그인 X 지워도 될까요", "플러그인 X 지울지 고민중", "플러그인 X 지우지 말라고 했잖아",
  "플러그인 X 지우지 말 것", "플러그인 X 지우지 맙시다", "플러그인 X 지워줘 근데 됐어", "플러그인 X 지워줘 했는데 됐어",
  "플러그인 X 지워줘 음 됐어", "됐어 그냥 그거", "플러그인 X 지워 부탁드립니다만",
]

const COURTESY_CLOSERS = ["thanks", "Thanks", "thank you", "please", "고마워", "고마워요", "감사합니다", "부탁해", "부탁해요"]

// One test per allowed class, plus the plain affirmatives that must keep verifying.
const VERIFIED: readonly (readonly [string, string])[] = [
  ["ASCII letters and spaces", "yes do it"],
  ["Hangul syllables", "응 해줘"],
  ["ASCII digits", "Bump the version to 123"],
  ["an apostrophe inside a word", "Let's remove plugins X and Y"],
  ["a final period", "yes do it."],
  ["a final exclamation mark", "응 해줘!"],
  ["mixed Latin and Hangul", "플러그인 X 지워줘"],
  ["a leading closer", "thanks remove plugins X and Y"],
  ["a trailing closer", "플러그인 X 지워 고마워"],
  ["a past tense followed by more", "백업 다 됐어 플러그인 X 지워"],
  ["a past tense in a clause", "백업 됐으면 플러그인 X 지워"],
  ["a contrast that is not a refusal", "X가 아니라 플러그인 Y를 지워"],
  ["a filler word", "일단 플러그인 X부터 지워"],
]

describe("consent corpus: a partial quote never verifies", () => {
  test.each(PARTIAL_QUOTES)("%p quoting %p", (said, quote) => {
    expect(source(said, quote)).toBe("agent")
  })
  test.each(EN_FOLLOWING_RETRACTIONS)("English instruction, then %p", (more) => {
    expect(source(`${EN_INSTRUCTION} ${more}`, EN_QUOTE)).toBe("agent")
    expect(source(`${stripEnd(EN_INSTRUCTION)} ${more}`, EN_QUOTE)).toBe("agent")
  })
  test.each(KO_FOLLOWING_RETRACTIONS)("Korean instruction, then %p", (more) => {
    expect(source(`${KO_INSTRUCTION} ${more}`, KO_QUOTE)).toBe("agent")
    expect(source(`${KO_QUOTE} ${more}`, KO_QUOTE)).toBe("agent")
  })
})

describe("consent corpus: a whole message outside the character allowlist never verifies", () => {
  test.each(REFUSED_CHARACTER_CLASSES)("%s: %p", (_class, said) => {
    expect(source(said, said)).toBe("agent")
    expect(source(said, stripEnd(said))).toBe("agent")
  })
})

describe("consent corpus: a verifiable message that is itself not consent stays a suggestion", () => {
  test.each(WHOLE_MESSAGE_NON_CONSENT)("%p", (said) => {
    expect(source(said, stripEnd(said))).toBe("agent")
  })
  test.each([...EN_FOLLOWING_RETRACTIONS, ...KO_FOLLOWING_RETRACTIONS])("retraction %p inside the quoted message", (retraction) => {
    const said = inSentence(retraction)
    expect(source(said, stripEnd(said))).toBe("agent")
  })
})

describe("consent corpus: the user's whole verifiable message verifies", () => {
  test.each(VERIFIED)("%s: %p", (_class, said) => {
    expect(source(said, said)).toBe("user")
  })
  test.each(COURTESY_CLOSERS)("instruction followed by closer %p", (closer) => {
    const [instruction, quote] = /[가-힣]/.test(closer) ? [KO_QUOTE, KO_QUOTE] : [stripEnd(EN_INSTRUCTION), EN_QUOTE]
    expect(source(`${instruction} ${closer}`, quote)).toBe("user")
  })
  test("a message that is only a closer verifies nothing", () => {
    expect(source("thanks", "thanks")).toBe("agent")
  })
})
