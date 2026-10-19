import { describe, expect, test } from "bun:test"

import { blankConfigSecrets, transcriptText } from "./collect"

describe("blankConfigSecrets", () => {
  test("#given provider headers, api keys and nested tokens in a config #when it is prepared for a report #then their values are blanked while the shape and safe values stay", () => {
    const config = {
      model: "anthropic/claude-opus-5-5",
      provider: {
        custom: {
          baseURL: "https://user:pass@llm.example.test/v1",
          apiKey: "sk-live-abc",
          headers: { "x-org": "acme", authorization: "Bearer zzz" },
          options: { timeout: 30 },
        },
      },
      mcp: { github: { env: { GITHUB_TOKEN: "ghp_x" }, command: "gh-mcp" } },
    }

    const blanked = blankConfigSecrets(config)

    expect(blanked).toEqual({
      model: "anthropic/claude-opus-5-5",
      provider: {
        custom: {
          baseURL: "https://<redacted>@llm.example.test/v1",
          apiKey: "<redacted>",
          headers: { "x-org": "<redacted>", authorization: "<redacted>" },
          options: { timeout: 30 },
        },
      },
      mcp: { github: { env: { GITHUB_TOKEN: "<redacted>" }, command: "gh-mcp" } },
    })
  })
})

describe("transcriptText", () => {
  const entry = (role: string, text: string, timestamp = "2026-10-19T02:09:51.000Z") => ({
    type: "message",
    timestamp,
    message: { role, content: [{ type: "text", text }] },
  })

  test("#given a long session #when the transcript is collected #then only the last 50 messages are kept, oldest first", () => {
    const entries = Array.from({ length: 70 }, (_, index) => entry("user", `message ${index}`))

    const lines = transcriptText(entries).split("\n")

    expect(lines).toHaveLength(50)
    expect(lines[0]).toContain("message 20")
    expect(lines.at(-1)).toContain("message 69")
  })

  test("#given a huge tool result #when the transcript is collected #then its head and tail stay and the middle is marked as cut", () => {
    const big = `${"A".repeat(3000)}MIDDLE${"Z".repeat(3000)}`
    const text = transcriptText([entry("toolResult", big)])

    expect(text).toContain("AAAA")
    expect(text).toContain("ZZZZ")
    expect(text).not.toContain("MIDDLE")
    expect(text).toMatch(/\[\d+ characters cut\]/)
  })

  test("#given entries that are not messages #when the transcript is collected #then they are left out", () => {
    const text = transcriptText([
      { type: "custom", customType: "memory", data: { secret: "memory body" } },
      entry("assistant", "done"),
    ])

    expect(text).not.toContain("memory body")
    expect(text).toContain("assistant")
    expect(text).toContain("done")
  })
})
