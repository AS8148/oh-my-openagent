import { describe, expect, test } from "bun:test"

import { HERDR_AGENT_LABEL, withHerdrAgentHint } from "../bin/lib/herdr-agent-hint.js"

describe("withHerdrAgentHint (#10448)", () => {
  test("#given an interactive launch inside herdr #then the engine is named the way herdr reads it", () => {
    expect(withHerdrAgentHint({ HERDR_ENV: "1" }, ["fix the bug"]).HERDR_AGENT).toBe(HERDR_AGENT_LABEL)
    expect(HERDR_AGENT_LABEL).toBe("pi")
  })

  test("#given no arguments inside herdr #then the hint is set", () => {
    expect(withHerdrAgentHint({ HERDR_ENV: "1" }, []).HERDR_AGENT).toBe("pi")
  })

  test.each([
    ["outside herdr", {}, []],
    ["HERDR_ENV other than 1", { HERDR_ENV: "0" }, []],
    ["a print run", { HERDR_ENV: "1" }, ["-p", "hi"]],
    ["a --print run", { HERDR_ENV: "1" }, ["--print", "hi"]],
    ["a protocol run", { HERDR_ENV: "1" }, ["--mode", "rpc"]],
    ["a --mode= run", { HERDR_ENV: "1" }, ["--mode=json"]],
  ] as const)("#given %s #then no hint is set", (_name, env, args) => {
    expect(withHerdrAgentHint({ ...env }, [...args]).HERDR_AGENT).toBeUndefined()
  })

  test("#given a HERDR_AGENT the user set #then it is left as is", () => {
    expect(withHerdrAgentHint({ HERDR_ENV: "1", HERDR_AGENT: "claude" }, []).HERDR_AGENT).toBe("claude")
  })

  test("#given an empty HERDR_AGENT #then it is treated as unset", () => {
    expect(withHerdrAgentHint({ HERDR_ENV: "1", HERDR_AGENT: "" }, []).HERDR_AGENT).toBe("pi")
  })
})
