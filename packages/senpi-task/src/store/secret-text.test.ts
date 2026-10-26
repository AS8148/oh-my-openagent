import { describe, expect, test } from "bun:test"

import { READABLE_NAMED_VALUES, READABLE_PROVIDER_TEXT, SECRET_CELLS } from "../manager/__fixtures__/secret-inventory"
import { redactSecretText } from "./secret-text"

// The same generated matrix senpi#4283 runs against its stream boundary: every secret shape, key spelling, quoting and
// container. omo stores provider text from children, so its redactor must clear exactly the same cells.
describe("redactSecretText over the shared secret matrix (#11355)", () => {
  test.each(SECRET_CELLS.map((cell) => [cell.name, cell] as const))("#given %s #when redacted #then the secret is gone", (_name, cell) => {
    const redacted = redactSecretText(cell.text)

    expect(redacted).toContain("[REDACTED]")
    expect(redacted.includes(cell.secret)).toBe(false)
    expect(redactSecretText(redacted)).toBe(redacted)
  })

  test("#given model ids, error codes and request ids #when redacted #then the text is unchanged", () => {
    expect(redactSecretText(READABLE_PROVIDER_TEXT)).toBe(READABLE_PROVIDER_TEXT)
  })

  test.each([...READABLE_NAMED_VALUES, "MAX_TOKENS=4096 exceeded"])("#given %s #when redacted #then the text is unchanged", (text) => {
    expect(redactSecretText(text)).toBe(text)
  })

  test("#given a short cookie value #when redacted #then every cookie value is gone", () => {
    expect(redactSecretText("Cookie: a=1; sid=s3cr3t")).toBe("Cookie: a=[REDACTED]; sid=[REDACTED]")
  })
})

const MB = 1 << 20
const fill = (unit: string): string => unit.repeat(Math.ceil(MB / unit.length)).slice(0, MB)

// Inputs that made the previous name pattern retry one long run from every position (quadratic), plus every other
// rule's worst case.
const ADVERSARIAL: readonly (readonly [label: string, text: string])[] = [
  ["a keyword repeated", fill("key")],
  ["a separated keyword repeated", fill("token_")],
  ["a keyword inside a word repeated", fill("aaaaakey")],
  ["short credential values repeated", fill("key: a ")],
  ["separators repeated", fill("a:")],
  ["whitespace after a credential name", `key:${" ".repeat(MB)}`],
  ["cookie pairs repeated", `Cookie: ${fill("a=1; ")}`],
  ["cookie names repeated", fill("Cookie: ")],
  ["open credential objects repeated", fill("api_key: {")],
  ["XML credential tags repeated", fill("<apiKey>")],
  ["URL userinfo heads repeated", fill("https://u:")],
  ["bearer schemes repeated", fill("bearer ")],
  ["quotes after a name", `key${fill('\\"')}`],
  ["names past the length bound", fill(`${"a".repeat(129)}_api_key: x `)],
]

describe("redactSecretText stays linear (#11355, senpi#4283)", () => {
  test.each(ADVERSARIAL)("#given 1 MB of %s #when redacted #then it finishes in under 50 ms", (_label, text) => {
    let best = Number.POSITIVE_INFINITY
    for (let attempt = 0; attempt < 3; attempt++) {
      const start = performance.now()
      redactSecretText(text)
      best = Math.min(best, performance.now() - start)
    }
    expect(best).toBeLessThan(50)
  })
})
