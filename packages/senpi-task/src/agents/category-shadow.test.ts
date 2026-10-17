import { describe, expect, test } from "bun:test"

import { categoryShadowedAgentNames } from "./category-shadow"

describe("categoryShadowedAgentNames", () => {
  test("#given an agent that sets its own model under a retired alias key #when a category uses the canonical name #then it is not reported", () => {
    // given: the reviewer was renamed; its chain still lives under the old key, which resolves to the new name
    const config = {
      categories: { "omo-native-code-reviewer": { model: "a/b" } },
      agents: { "omo-senpi-code-reviewer": { model: "x/y" } },
    }

    // when
    const names = categoryShadowedAgentNames(config)

    // then
    expect(names).toEqual([])
  })

  test("#given an agent alias key without its own model #when a category uses the canonical name #then it is still reported", () => {
    // given
    const config = {
      categories: { "omo-native-code-reviewer": { model: "a/b" } },
      agents: { "omo-senpi-code-reviewer": { description: "reviews" } },
    }

    // when
    const names = categoryShadowedAgentNames(config)

    // then
    expect(names).toEqual(["omo-native-code-reviewer"])
  })
})
