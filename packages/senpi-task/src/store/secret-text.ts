// The same value-based rules as senpi's redactSecrets (packages/ai/src/utils/provider-error.ts, senpi#4283): a task's
// stored error text is provider output and reaches the parent session and its clients. parity: the shared
// secret matrix in __fixtures__/secret-inventory.ts is the same generator senpi's tests use.

// Environment assignments such as OPENAI_API_KEY=value, whatever the value's length.
const ENV_ASSIGNMENT = /\b([A-Z][A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|AUTH)[A-Z0-9_]*=)[^\s'"]+/g

// A name that holds a credential: any header, field, query or form name containing one of these words, with
// "-", "_" or "." separators and any prefix or suffix (x-api-key, openai_api_key, aws_secret_access_key, Set-Cookie).
const SECRET_NAME = String.raw`[A-Za-z0-9_.-]*(?:key|token|secret|auth|cookie|session|passw(?:or)?d|credential|signature)[A-Za-z0-9_.-]*`
// Between the name and its value: closing quotes or escapes, ":" or "=", an array or Go map bracket, opening quotes
// or escapes, and an auth scheme.
const SEPARATOR = String.raw`[\\"'\`]*\s*[:=]\s*\[?\s*[\\"'\`]*\s*(?:(?:bearer|basic|token|apikey)(?:\s+|%20))?`
// A token-like run: base64, base64url, hex, URL-encoded and key-prefix characters.
const VALUE_CHARS = String.raw`[A-Za-z0-9+/=_.~%-]`
// A value an earlier rule already replaced is left alone, so the rules compose in any order.
const FRESH = String.raw`(?!\[redacted\])`
const MIN_SECRET_LENGTH = 16

const NAMED_VALUE = new RegExp(
  String.raw`(?<![A-Za-z0-9_.-])(${SECRET_NAME})(${SEPARATOR})${FRESH}${VALUE_CHARS}{${MIN_SECRET_LENGTH},}`,
  "gi",
)
const BEARER_VALUE = new RegExp(String.raw`\b(bearer\s+)${FRESH}${VALUE_CHARS}{8,}`, "gi")
// Credential-shaped values recognized by their prefix wherever they appear; a letter before the prefix means a word.
const PREFIXED_VALUES: readonly RegExp[] = [
  /(?<![A-Za-z])sk-[A-Za-z0-9_-]{8,}/g,
  /(?<![A-Za-z])gh[pousr]_[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z])github_pat_[A-Za-z0-9_]{20,}/g,
  /(?<![A-Za-z])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/g,
  /(?<![A-Za-z])AIza[0-9A-Za-z_-]{30,}/g,
  // A JWT's header segment is base64url JSON, so it always begins with `eyJ`.
  /(?<![A-Za-z])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
]

/**
 * Mask credentials in provider or gateway text by value, not by a list of names: a token-like run of at least 16
 * characters after any credential-ish name (in a header, JSON, array, Go map, Python repr, URL query or form body,
 * at any escaping depth), a bearer token, and known key prefixes anywhere. Model ids, error codes and request ids
 * stay readable.
 */
export function redactSecretText(text: string, replacement = "[REDACTED]"): string {
  let redacted = text.replace(ENV_ASSIGNMENT, `$1${replacement}`).replace(NAMED_VALUE, `$1$2${replacement}`).replace(BEARER_VALUE, `$1${replacement}`)
  for (const pattern of PREFIXED_VALUES) redacted = redacted.replace(pattern, replacement)
  return redacted
}
