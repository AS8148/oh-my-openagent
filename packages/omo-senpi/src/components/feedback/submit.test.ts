import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildDraft, type UploadRedactor } from "./draft"
import { submitReport, type ReportTransport } from "./submit"

const redactTokens: UploadRedactor = (text) => {
  let count = 0
  const out = text.replace(/ghp_[A-Za-z0-9]{8,}/g, () => {
    count++
    return "<redacted>"
  })
  return { text: out, count }
}

const draft = buildDraft({
  draftId: "drf_1",
  collected: [
    { id: "environment", text: "omo 5.1.36 · macOS · arm64" },
    { id: "session", text: "user: it hangs" },
  ],
  redact: redactTokens,
  destination: "intake",
  signedIn: false,
})

const client = { app: "cli", omo: "5.1.36", senpi: "2026.10.18-1", os: "darwin", arch: "arm64", locale: "en-US", channel: "beta" }

const dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "omo-feedback-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const recordingTransport = (status: number, body: unknown) => {
  const sent: { url: string; init: RequestInit }[] = []
  const transport: ReportTransport = async (url, init) => {
    sent.push({ url, init })
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  }
  return { sent, transport }
}

describe("submitReport", () => {
  test("#given a signed-out user who pasted a token into the description #when the report is submitted #then the token never leaves and the delete token is kept on this device", async () => {
    const stateDir = tempDir()
    const { sent, transport } = recordingTransport(201, { id: "rpt_1", deleteToken: "dt_secret" })

    const result = await submitReport({
      draft,
      kind: "bug",
      description: "it hangs, my token ghp_abcdefgh1234 is in the env",
      redact: redactTokens,
      client,
      env: {},
      stateDir,
      apiOrigin: "https://api.example.test",
      accessToken: null,
      transport,
    })

    expect(result).toEqual({ kind: "sent", reportId: "rpt_1" })
    expect(sent).toHaveLength(1)
    const request = sent[0]
    const payload = String(request?.init.body)
    expect(request?.url).toBe("https://api.example.test/v1/reports")
    expect(payload).not.toContain("ghp_")
    expect(JSON.parse(payload).sections.map((section: { id: string }) => section.id)).toEqual(["description", "environment", "session"])
    expect(new Headers(request?.init.headers).get("authorization")).toBeNull()
    const ledger = readFileSync(join(stateDir, "feedback", "sent.json"), "utf8")
    expect(JSON.parse(ledger)).toEqual([{ id: "rpt_1", deleteToken: "dt_secret", createdAt: expect.any(String) }])
    expect(statSync(join(stateDir, "feedback", "sent.json")).mode & 0o077).toBe(0)
  })

  test("#given the organization turned feedback uploads off #when the report is submitted #then nothing is sent and the report is saved as a private file", async () => {
    const stateDir = tempDir()
    const { sent, transport } = recordingTransport(201, { id: "never" })

    const result = await submitReport({
      draft,
      kind: "feedback",
      description: "idea",
      redact: redactTokens,
      client,
      env: { OMO_DISABLE_FEEDBACK: "1" },
      stateDir,
      apiOrigin: "https://api.example.test",
      accessToken: "at_1",
      transport,
    })

    expect(sent).toHaveLength(0)
    expect(result.kind).toBe("saved")
    if (result.kind !== "saved") throw new Error("expected a saved report")
    const saved = JSON.parse(readFileSync(result.path, "utf8"))
    expect(saved.sections[0]).toEqual({ id: "description", text: "idea" })
    expect(statSync(result.path).mode & 0o077).toBe(0)
  })

  test("#given the service rejects a secret it still found #when the report is submitted #then the user is told why and no report id is claimed", async () => {
    const { transport } = recordingTransport(400, { error: { code: "secret_detected", detail: { sectionId: "logs" } } })

    const result = await submitReport({
      draft,
      kind: "bug",
      description: "x",
      redact: redactTokens,
      client,
      env: {},
      stateDir: tempDir(),
      apiOrigin: "https://api.example.test",
      accessToken: "at_1",
      transport,
    })

    expect(result).toEqual({ kind: "refused", reason: "secret-detected" })
  })

  test("#given a signed-in user #when the report is submitted #then the request carries their access token and no delete token is stored", async () => {
    const stateDir = tempDir()
    const { sent, transport } = recordingTransport(201, { id: "rpt_2" })

    await submitReport({
      draft,
      kind: "bug",
      description: "x",
      redact: redactTokens,
      client,
      env: {},
      stateDir,
      apiOrigin: "https://api.example.test",
      accessToken: "at_1",
      transport,
    })

    expect(new Headers(sent[0]?.init.headers).get("authorization")).toBe("Bearer at_1")
    expect(() => readFileSync(join(stateDir, "feedback", "sent.json"), "utf8")).toThrow()
  })

  test.each([
    [413, "too-large"],
    [429, "rate-limited"],
    [503, "unavailable"],
  ] as const)("#given the service answers %i #when the report is submitted #then it is refused as %s", async (status, reason) => {
    const { transport } = recordingTransport(status, { error: { code: "x" } })

    const result = await submitReport({
      draft,
      kind: "bug",
      description: "x",
      redact: redactTokens,
      client,
      env: {},
      stateDir: tempDir(),
      apiOrigin: "https://api.example.test",
      accessToken: null,
      transport,
    })

    expect(result).toEqual({ kind: "refused", reason })
  })
})
