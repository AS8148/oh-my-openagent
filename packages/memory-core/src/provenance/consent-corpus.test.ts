import { describe, expect, test } from "bun:test"

import { EN_INSTRUCTION, EN_QUOTE, inSentence, KO_INSTRUCTION, KO_QUOTE, source, stripEnd } from "./consent-corpus.shapes"

// The consent rule (#10488, lead ruling on #10498): a "user said" receipt verifies ONLY when the quote is the user's
// ENTIRE message, give or take whitespace, edge punctuation and a closed list of courtesy closers. Anything else in that
// message means the words were not the user's whole instruction, so the claim stays a suggestion and the agent asks again.
// The in-message scan still refuses a message that is itself a refusal, hedge or question.

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

// Everything the last two reviews found past a quote that stops before the end of the message (0f4147b789 and
// 9a65f76244): words in the same clause, a colon, a dash, an ellipsis, a period with no space, and 됐 interjections.
const TRAILING_AFTER_QUOTE: readonly (readonly [string, string])[] = [
  ["Remove plugins X and Y just joking", EN_QUOTE],
  ["Remove plugins X and Y then put them back", EN_QUOTE],
  ["Remove plugins X and Y \u2014 reconsider that", EN_QUOTE],
  ["Remove plugins X and Y: I'm joking", EN_QUOTE],
  ["Remove plugins X and Y \u2014 psych", EN_QUOTE],
  ["Remove plugins X and Y\u2026 put them back", EN_QUOTE],
  ["Remove plugins X and Y.Put them back", EN_QUOTE],
  ["Remove plugins X and Y, keep them.", EN_QUOTE],
  ["Remove plugins X and Y;keep them", EN_QUOTE],
  ["Remove plugins X and Y. Then keep them.", "remove plugins X and Y. Then"],
  ["Remove plugins X and Y. Now. Okay keep them.", "plugins X and Y. Now"],
  ["Please remove plugins X and Y now.", EN_QUOTE],
  ["플러그인 X 지워줘 했다가 다시 살려", "플러그인 X 지워줘"],
  ["플러그인 X 지워줘 아 근데 다시 넣어", "플러그인 X 지워줘"],
  ["플러그인 X 지워줘 아 잊어", "플러그인 X 지워줘"],
  ["플러그인 X 지워줘 생각해볼게", "플러그인 X 지워줘"],
  ["플러그인 X 지워줘 무시해", "플러그인 X 지워줘"],
  ["플러그인 X 지워줘 ㅋㅋ 구라", "플러그인 X 지워줘"],
  ["플러그인 X 지워줘 는 거짓말", "플러그인 X 지워줘"],
  ["플러그인 X 지워줘 근데 됐어", "플러그인 X 지워줘"],
  ["플러그인 X 지워줘 했는데 됐어", "플러그인 X 지워줘"],
  ["플러그인 X 지워줘 ㅋ 됐어", "플러그인 X 지워줘"],
  ["플러그인 X 지워줘 음 됐어", "플러그인 X 지워줘"],
  ["플러그인 X 지워 주세요", KO_QUOTE],
  ["플러그인 X 지워. 그리고 그건 그대로", "플러그인 X 지워. 그리고"],
  ["じゃあこのプラグインを削除してください", "このプラグインを削除して"],
]

const FOLLOW_UPS_OF_ANY_KIND = [
  "Thanks. Then push it.", "Also update plugin Z.", "Also run the tests.", "Do it now.", "Nobody uses them.", "Notably, they are unused.",
  "안에 있는 것도 지워", "일단 그거부터 해", "아니면 Y도 지워", "X가 아니라 Y도 같이 지워", "백업은 이미 완료됐어", "그만큼 중요해",
  "고마워요 진짜", "Thanks a lot.", "Then push it.", "No rush.", "No worries.", "Don't forget to run the tests.",
  "그리고 Y도 정리해", "끝나면 알려줘", "백업 다 됐어", "준비 됐어", "잠시 후에 푸시해",
]

// A message that is itself a refusal, hedge or question stays a suggestion even when quoted whole.
const WHOLE_MESSAGE_NON_CONSENT = [
  "Don't delete the prod database yet.", "Don\u2019t delete the prod database yet.", "DON'T delete the prod database.",
  "Never delete the prod database.", "Should I remove plugins X and Y", "remove plugins X and Y?", "Thanks, remove plugins X and Y?", "Can I remove plugins X and Y", "Maybe remove plugins X and Y later.",
  "remove plugins X and Y is a terrible idea.", "아직 플러그인 X 지우기는 하지 마", "플러그인 X 지워도 될까", "플러그인 X 지워도 될까요",
  "플러그인 X 지울지 고민중", "플러그인 X 지우지 말라고 했잖아", "플러그인 X 지우지 말 것", "플러그인 X 지우지 맙시다",
  "플러그인 X 지워줘 근데 됐어", "플러그인 X 지워줘 했는데 됐어", "플러그인 X 지워줘 ㅋ 됐어", "플러그인 X 지워줘 음 됐어", "됐어 그냥 그거",
]

const COURTESY_CLOSERS = [
  "Thanks.", "Thanks", "Thank you.", "Thank you!", "please", "고마워", "고마워.", "고마워요", "감사합니다", "감사합니다.", "부탁해", "부탁해!", "부탁해요",
]

const WHOLE_MESSAGE_MUST_STAY: readonly (readonly [string, string])[] = [
  ["응 해줘", "응 해줘"],
  ["yes do it", "yes do it"],
  ["Yes, do it!", "Yes, do it"],
  ["Please remove plugins X and Y now.", "remove plugins X and Y now"],
  ["Thanks. Remove plugins X and Y.", EN_QUOTE],
  ["Remove plugins X and Y, thanks.", EN_QUOTE],
  ["  remove plugins X and Y!!  ", EN_QUOTE],
  ["플러그인 X 지워줘", "플러그인 X 지워줘"],
  ["플러그인 X 지워 주세요", "플러그인 X 지워 주세요"],
  ["고마워. 플러그인 X 지워", KO_QUOTE],
  ["플러그인 X 지워, 고마워", KO_QUOTE],
  ["じゃあこのプラグインを削除してください", "じゃあこのプラグインを削除してください"],
  ["Nobody uses them, so remove plugins X and Y.", "Nobody uses them, so remove plugins X and Y"],
  ["X가 아니라 플러그인 Y를 지워", "X가 아니라 플러그인 Y를 지워"],
  ["그만큼 쓸모없으니 플러그인 X 지워", "그만큼 쓸모없으니 플러그인 X 지워"],
  ["일단 플러그인 X부터 지워", "일단 플러그인 X부터 지워"],
  // 됐 inside a message, followed by more of it, is a plain past tense.
  ["백업 다 됐어 플러그인 X 지워", "백업 다 됐어 플러그인 X 지워"],
  ["백업은 이미 완료됐으니 플러그인 X 지워", "백업은 이미 완료됐으니 플러그인 X 지워"],
  ["백업 됐으면 플러그인 X 지워", "백업 됐으면 플러그인 X 지워"],
]

describe("consent corpus: anything besides the quote leaves it a suggestion", () => {
  test.each(TRAILING_AFTER_QUOTE)("%p quoting %p", (said, quote) => {
    expect(source(said, quote)).toBe("agent")
  })
  test.each([...EN_FOLLOWING_RETRACTIONS, ...FOLLOW_UPS_OF_ANY_KIND.filter((f) => !/[가-힣]/.test(f))])("English instruction, then %p", (more) => {
    expect(source(`${EN_INSTRUCTION} ${more}`, EN_QUOTE)).toBe("agent")
    expect(source(`${stripEnd(EN_INSTRUCTION)} ${more}`, EN_QUOTE)).toBe("agent")
  })
  test.each([...KO_FOLLOWING_RETRACTIONS, ...FOLLOW_UPS_OF_ANY_KIND.filter((f) => /[가-힣]/.test(f))])("Korean instruction, then %p", (more) => {
    expect(source(`${KO_INSTRUCTION} ${more}`, KO_QUOTE)).toBe("agent")
    expect(source(`${KO_QUOTE} ${more}`, KO_QUOTE)).toBe("agent")
    expect(source(`${KO_QUOTE}\n${more}`, KO_QUOTE)).toBe("agent")
  })
})

describe("consent corpus: a message that is itself not consent stays a suggestion when quoted whole", () => {
  test.each(WHOLE_MESSAGE_NON_CONSENT)("%p", (said) => {
    expect(source(said, stripEnd(said))).toBe("agent")
  })
  test.each([...EN_FOLLOWING_RETRACTIONS, ...KO_FOLLOWING_RETRACTIONS])("retraction %p inside the quoted message", (retraction) => {
    const said = inSentence(retraction)
    expect(source(said, stripEnd(said))).toBe("agent")
  })
})

describe("consent corpus: the user's whole message verifies", () => {
  test.each(COURTESY_CLOSERS)("instruction followed by closer %p", (closer) => {
    const [instruction, quote] = /[가-힣]/.test(closer) ? [KO_INSTRUCTION, KO_QUOTE] : [EN_INSTRUCTION, EN_QUOTE]
    expect(source(`${instruction} ${closer}`, quote)).toBe("user")
  })
  test.each(WHOLE_MESSAGE_MUST_STAY)("%p quoting %p", (said, quote) => {
    expect(source(said, quote)).toBe("user")
  })
})
