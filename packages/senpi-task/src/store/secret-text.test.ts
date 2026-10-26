import { describe, expect, test } from "bun:test"

import { READABLE_PROVIDER_TEXT, SECRET_CELLS } from "../manager/__fixtures__/secret-inventory"
import { redactSecretText } from "./secret-text"

// The same generated matrix senpi#4283 runs against its stream boundary: every secret shape, key spelling, quoting and
// container. omo stores provider text from children, so its redactor must clear exactly the same cells.
describe("redactSecretText over the shared secret matrix (#11355)", () => {
  test.each(SECRET_CELLS.map((cell) => [cell.name, cell] as const))("#given %s #when redacted #then the secret is gone", (_name, cell) => {
    const redacted = redactSecretText(cell.text)

    expect(redacted).toContain("[REDACTED]")
    expect(redacted.includes(cell.secret)).toBe(false)
  })

  test("#given model ids, error codes and request ids #when redacted #then the text is unchanged", () => {
    expect(redactSecretText(READABLE_PROVIDER_TEXT)).toBe(READABLE_PROVIDER_TEXT)
  })
})
