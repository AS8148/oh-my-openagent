// Shared message shapes for the consent corpus tests (#10488 / #10498).
import { resolveClaimReceipt } from "./claim"

export const EN_INSTRUCTION = "Remove plugins X and Y."
export const EN_QUOTE = "remove plugins X and Y"
export const KO_INSTRUCTION = "플러그인 X 지워."
export const KO_QUOTE = "플러그인 X 지워"
export const HANGUL = /[\u3131-\u318e\uac00-\ud7a3]/u

export const source = (said: string, quote: string): string => resolveClaimReceipt({ source: "user", userQuote: quote }, [said]).source

export const stripEnd = (text: string): string => text.replace(/[.!?]+$/u, "")

// The retraction INSIDE the quoted words: the quote is the whole message, so nothing follows it and the last-word rule
// cannot help. Only the in-sentence scan stands between these and a "user said" receipt.
export const inSentence = (phrase: string): string => HANGUL.test(phrase) ? `${KO_QUOTE} ${phrase}` : `Remove plugins X and Y, ${phrase}`
