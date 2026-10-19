// Shared helper for the consent corpus tests (#10488 / #10498).
import { resolveClaimReceipt } from "./claim"

export const source = (said: string, quote: string): string => resolveClaimReceipt({ source: "user", userQuote: quote }, [said]).source
