// Whether a user sentence reads as the user's own affirmative instruction or statement (#10488). The rule is "when in
// doubt, it stays a suggestion": a question, any negation, hedge or objection anywhere in the sentence, a sentence that
// talks about the agent's suggestion all mean the words are not consent; claim.ts also refuses a quote that is not the
// user's whole message.
// A false "suggestion" costs one confirmation; a false "user said" is the incident this guards against.

// A Korean question often has no mark: 될까, 지워도 되나, 지워줄래. Permission without a mark (지워도 돼) stays a
// suggestion too: when in doubt, it is not consent.
const QUESTION = /[?\uff1f]|(?:까|까요|나요|니|냐|ㄹ까|을까|를까|는지|은지|ㄴ지|할지|을지|ㄹ지|[되하있없주가오]나|도\s*돼|도\s*되|줄래|할래)(?:요)?\s*[.!]*$/u
// "Do it now" is an instruction; "do we/you ..." is a question.
const QUESTION_LEAD = /^(?:should|could|can|shall|may|do(?=\s+(?:i|we|you|they|he|she)\b)|does|did|would|will|is|are|was|were|have|has|why|what|how|whether|if)\b/u
const NEGATION_OR_HEDGE = /\b(?:don'?t|do not|doesn'?t|does not|didn'?t|did not|never|not|no+|nor|nope|nah|shouldn'?t|should not|mustn'?t|must not|can'?t|cannot|won'?t|wouldn'?t|isn'?t|aren'?t|stop|avoid|without|unless|if|whether|maybe|perhaps|might|probably|possibly|later|wait|hold off|hold on|cancel|scratch that|never ?mind|just kidding|kidding|before|not sure|unsure|wonder|thinking about|considering|bad idea|terrible|wrong|mistake|instead|rather than|you suggested|you said|you proposed|your suggestion|you recommended|actually|forget it|nvm|ignore that|disregard|undo|changed my mind|second thought|leave (?:it|them)|jk|keep (?:them|it|those|that|these|everything)|scrap (?:that|it)|strike that|hang on|hold up|one sec(?:ond)?|abort|revert (?:that|it)|skip (?:it|that|this)|forget (?:that|about it)|drop (?:it|that|them)|ignore (?:it|me|my)|i guess|meh|suggesting|who said|asked you)\b/u
// Hangul has no \b in JavaScript (it only sees ASCII word characters), so Korean stems are matched as substrings: any
// conjugation of a refusal or prohibition (아니야, 아닙니다, 하지 마세요, 지우지 맙시다, 잠깐만, 안 돼) still hits.
const KOREAN_NEGATION_OR_HEDGE = /지\s*마|지\s*말|지\s*맙|말아|말고|말자|말기|말라|않|안\s|안돼|못\s|금지|보류|나중에|혹시|아마|고민|생각\s*중|다시\s*생각|모르|아니(?!면|라\s+\S)|아닙|아님|아냐|아닌|아뇨|ㄴㄴ|\u1102\u1102|노노|싫|별로|틀렸|잘못|대신|잠깐|잠시|기다려|그만(?!큼)|취소(?!된)|멈춰|멈추|냅둬|놔둬|그대로\s*둬|그냥\s*두|(?:^|\s)둬|(?:^|\s)마라|(?:^|\s)두세요|필요\s*없|관둬|관두|농담|장난|되돌|원래대로|다음에\s*하|아직(?:이|은|\s*[.!]*$)|안\s*할|놉|패스(?!워드)|없던\s*걸로|만[.!~\s]*$|스톱|네가\s*(?:말|추천|제안)|추천한|제안한/u

// 됐 that ENDS a message or opens a clause is an interjection ("never mind": 근데 됐어, 아 됐어, 됐어 그냥); 됐 followed by
// more of the message is a plain past tense (백업 다 됐어 플러그인 X 지워). A bare statement that ends in 됐어 therefore
// stays a suggestion: when in doubt, it is not consent.
const DWAESS_RETRACTION = /(?:^|[.!?。！？,;，；、~]\s*)됐|됐[가-힣]*[\s.!?~]*$|(?:[아어워해줘봐라]|세요|해요|줘요|그건|그거|이제|그냥)\s+됐(?!으니|으면|으므로|을)/u

export function foldQuotes(text: string): string {
  return text.replace(/[\u2018\u2019\u201B\u2032\uFF07]/gu, "'").replace(/[\u201C\u201D\u201F\u2033\uFF02]/gu, '"')
}

// Lead ruling: characters are refused by CLASS, not by list. The scan sees NFKC text, so accented letters, Hangul
// syllables and kana with voicing marks are already precomposed letters. A message is consent only if every character is
// a letter, digit, whitespace or one of a small allowlist ( . , ! ' " ~ 〜 - 。 、 ). Everything else fails closed: a
// question mark in any script, an emoji or symbol, an emoticon, an ellipsis, a colon or semicolon, ANY combining mark
// (an invisible one can split "don't" so the word scan misses it, and some are prohibition overlays), and any
// default-ignorable code point (zero-width characters, variation selectors, Hangul fillers). A period counts only when it
// ends a word, and two stops in a row (。。。, 、、, . .) are an ellipsis. A Hangul vowel jamo on its own (ㅠ ㅜ ㅡ ㅗ) is a
// reaction, never part of an instruction, while consonant jamo (ㅇㅇ, "yes") stay allowed.
const NON_CONSENT_MARK = /[^\p{L}\p{N}\s.,!'"~\u301c\-\u3002\u3001]|\p{Default_Ignorable_Code_Point}|\.(?![\s\d]|$)|[.\u3002\u3001]\s*[.\u3002\u3001]|[\u314f-\u3163\u1161-\u1175]/u

function negatesOrHedges(sentence: string): boolean {
  return NEGATION_OR_HEDGE.test(sentence) || KOREAN_NEGATION_OR_HEDGE.test(sentence) || DWAESS_RETRACTION.test(sentence) || NON_CONSENT_MARK.test(sentence)
}

// Lead decision (#10498): the CLOSED list of courtesy closers that may surround a quoted user message. Nothing else.
export const COURTESY_CLOSERS: readonly string[] = [
  "thanks", "thank you", "thx", "please", "pls", "고마워요", "고마워", "감사합니다", "감사해요", "부탁드립니다", "부탁드려요", "부탁해요", "부탁해",
]

export function isAffirmativeStatement(sentence: string): boolean {
  if (QUESTION.test(sentence) || QUESTION_LEAD.test(sentence)) return false
  return !negatesOrHedges(sentence)
}
