// Whether a user sentence reads as the user's own affirmative instruction or statement (#10488). The rule is "when in
// doubt, it stays a suggestion": a question, any negation, hedge or objection anywhere in the sentence, a sentence that
// talks about the agent's suggestion, or a bare refusal right after it all mean the words are not consent. A false
// "suggestion" costs one confirmation; a false "user said" is the incident this guards against.

const QUESTION = /[?\uff1f]|(?:까|까요|나요|니|냐|ㄹ까|을까|를까|는지|은지|ㄴ지|할지|을지|ㄹ지)(?:요)?\s*[.!]*$/u
const QUESTION_LEAD = /^(?:should|could|can|shall|may|do|does|did|would|will|is|are|was|were|have|has|why|what|how|whether|if)\b/u
const NEGATION_OR_HEDGE = /\b(?:don'?t|do not|doesn'?t|does not|didn'?t|did not|never|not|no|nor|nope|shouldn'?t|should not|mustn'?t|must not|can'?t|cannot|won'?t|wouldn'?t|isn'?t|aren'?t|stop|avoid|without|unless|if|whether|maybe|perhaps|might|probably|possibly|later|wait|hold off|before|not sure|unsure|wonder|thinking about|considering|bad idea|terrible|wrong|mistake|instead|rather than|you suggested|you said|you proposed|your suggestion|you recommended)\b/u
const KOREAN_NEGATION_OR_HEDGE = /지\s*마|지\s*말|말아|말고|말자|말기|말라|않|안\s|안돼|못\s|금지|보류|나중에|일단|혹시|아마|고민|생각\s*중|모르|아니|싫|별로|틀렸|잘못|대신|네가\s*(?:말|추천|제안)|추천한|제안한/u
// JavaScript's \b only sees ASCII word characters, so it never matches after Hangul; end the match explicitly instead.
const BARE_REFUSAL = /^(?:no|nope|nah|don'?t|stop|wait|actually|아니|아니요|아뇨|싫어|싫어요|하지\s*마|잠깐|됐어|그만)(?![\p{L}\p{N}])/u

export function foldQuotes(text: string): string {
  return text.replace(/[\u2018\u2019\u201B\u2032\uFF07]/gu, "'").replace(/[\u201C\u201D\u201F\u2033\uFF02]/gu, '"')
}

export function isAffirmativeStatement(sentence: string, following: string | undefined): boolean {
  if (QUESTION.test(sentence) || QUESTION_LEAD.test(sentence)) return false
  if (NEGATION_OR_HEDGE.test(sentence) || KOREAN_NEGATION_OR_HEDGE.test(sentence)) return false
  return following === undefined || !BARE_REFUSAL.test(following)
}
