import { describe, expect, test } from "bun:test"

import { PROVIDERS_PATTERN } from "./event-schema-constraints"
import { joinProviders } from "./session-inventory"

describe("joinProviders", () => {
  test("#given known and private provider ids #then known ids ship, private ones become one custom token, sorted", () => {
    expect(joinProviders(["openai", "my-gateway", "anthropic", "corp-proxy"])).toBe("anthropic,custom,openai")
  })

  test("#given more ids than fit in 64 characters #then the value is cut at a token boundary and still matches the pattern", () => {
    const value = joinProviders(["alibaba-token-plan", "alibaba-token-plan-cn", "anthropic-subscription", "chatgpt-subscription", "openai"])
    expect(value.length).toBeLessThanOrEqual(64)
    expect(value.endsWith(",")).toBe(false)
    expect(new RegExp(PROVIDERS_PATTERN).test(value)).toBe(true)
    expect(value).toBe("alibaba-token-plan,alibaba-token-plan-cn,anthropic-subscription")
  })

  test("#given no providers #then the value is empty, which the session emitter omits", () => {
    expect(joinProviders([])).toBe("")
  })
})
