// Whether a user sentence reads as the user's own affirmative instruction or statement (#10488). The rule is "when in
// doubt, it stays a suggestion": a question, any negation, hedge or objection anywhere in the sentence, a sentence that
// talks about the agent's suggestion, or a retraction in the sentence right after it all mean the words are not consent.
// A false "suggestion" costs one confirmation; a false "user said" is the incident this guards against.

const QUESTION = /[?\uff1f]|(?:까|까요|나요|니|냐|ㄹ까|을까|를까|는지|은지|ㄴ지|할지|을지|ㄹ지)(?:요)?\s*[.!]*$/u
const QUESTION_LEAD = /^(?:should|could|can|shall|may|do|does|did|would|will|is|are|was|were|have|has|why|what|how|whether|if)\b/u
const NEGATION_OR_HEDGE = /\b(?:don'?t|do not|doesn'?t|does not|didn'?t|did not|never|not|no+|nor|nope|nah|shouldn'?t|should not|mustn'?t|must not|can'?t|cannot|won'?t|wouldn'?t|isn'?t|aren'?t|stop|avoid|without|unless|if|whether|maybe|perhaps|might|probably|possibly|later|wait|hold off|hold on|cancel|scratch that|never ?mind|just kidding|kidding|before|not sure|unsure|wonder|thinking about|considering|bad idea|terrible|wrong|mistake|instead|rather than|you suggested|you said|you proposed|your suggestion|you recommended|actually|forget it|nvm|ignore that|disregard|undo|changed my mind|second thought|leave (?:it|them)|jk)\b/u
// Hangul has no \b in JavaScript (it only sees ASCII word characters), so Korean stems are matched as substrings: any
// conjugation of a refusal or prohibition (아니야, 아닙니다, 하지 마세요, 지우지 맙시다, 잠깐만, 됐어요, 안 돼) still hits.
const KOREAN_NEGATION_OR_HEDGE = /지\s*마|지\s*말|지\s*맙|말아|말고|말자|말기|말라|않|안\s|안돼|못\s|금지|보류|나중에|혹시|아마|고민|생각\s*중|다시\s*생각|모르|아니(?!면|라(?!니까|고|구))|아닙|아님|아냐|아닌|아뇨|ㄴㄴ|\u1102\u1102|노노|싫|별로|틀렸|잘못|대신|잠깐|잠시|기다려|그만(?!큼)|(?:^|\s)됐(?:어|어요|다|고)?(?=[.!\s]|$)|취소|멈춰|멈추|냅둬|놔둬|그대로\s*둬|없던\s*걸로|스톱|네가\s*(?:말|추천|제안)|추천한|제안한/u

export function foldQuotes(text: string): string {
  return text.replace(/[\u2018\u2019\u201B\u2032\uFF07]/gu, "'").replace(/[\u201C\u201D\u201F\u2033\uFF02]/gu, '"')
}

function negatesOrHedges(sentence: string): boolean {
  return NEGATION_OR_HEDGE.test(sentence) || KOREAN_NEGATION_OR_HEDGE.test(sentence)
}

export function isAffirmativeStatement(sentence: string, following: string | undefined): boolean {
  if (QUESTION.test(sentence) || QUESTION_LEAD.test(sentence)) return false
  if (negatesOrHedges(sentence)) return false
  return following === undefined || !negatesOrHedges(following)
}
