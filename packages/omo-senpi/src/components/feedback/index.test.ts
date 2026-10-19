import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import type { SenpiExtensionAPI } from "../../extension/types"
import type { FeedbackDraft } from "./draft"
import { createFeedbackComponent, FEEDBACK_PREPARE_RPC_METHOD, FEEDBACK_SUBMIT_RPC_METHOD, noticeFor } from "./index"

type Handler = (data: unknown) => unknown | Promise<unknown>

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function host(options: { withRedactor: boolean; extraEnv?: Record<string, string>; noStateDir?: boolean }) {
  const pi = new FakeExtensionAPI()
  const handlers = new Map<string, Handler>()
  const api = pi as unknown as SenpiExtensionAPI
  Object.assign(api, {
    rpc: { emit: () => undefined, handle: (name: string, handler: Handler) => handlers.set(name, handler) },
    ...(options.withRedactor
      ? {
          redactForUpload: (text: string) => {
            let n = 0
            const out = text.replace(/sk-[A-Za-z0-9]{10,}/g, () => {
              n++
              return "<redacted>"
            })
            return { text: out, counts: { credential: n } }
          },
        }
      : {}),
  })
  const stateDir = mkdtempSync(join(tmpdir(), "omo-feedback-component-"))
  dirs.push(stateDir)
  const homeDir = mkdtempSync(join(tmpdir(), "omo-feedback-home-"))
  dirs.push(homeDir)
  const sent: string[] = []
  const component = createFeedbackComponent({
    env: { HOME: homeDir, OMO_CODING_AGENT_DIR: join(stateDir, "agent"), DO_NOT_TRACK: "1", ...options.extraEnv },
    ...(options.noStateDir === true ? {} : { stateDir }),
    omoVersion: "5.1.36",
    senpiVersion: "2026.10.18-1",
    channel: "beta",
    transport: async (_url, init) => {
      sent.push(String(init.body))
      return new Response(JSON.stringify({ id: "rpt_9" }), { status: 201 })
    },
  })
  return { pi, api, handlers, component, sent, stateDir, homeDir }
}

const sessionCtx = {
  cwd: "/tmp/project",
  model: { provider: "anthropic", id: "claude-opus-5-5" },
  sessionManager: {
    getSessionId: () => "ses_1",
    getBranch: () => [
      { type: "message", timestamp: "2026-10-19T02:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "deploy with key sk-abcdefghijkl" }] } },
      { type: "custom", customType: "omo-memory", data: { note: "private memory note" } },
    ],
  },
}

describe("feedback component", () => {
  test("#given a host without the upload redactor #when the desktop asks for a draft #then it is told feedback is unavailable instead of sending unredacted text", async () => {
    const { api, handlers, component } = host({ withRedactor: false })
    await component.register(api, { logger: console, config: { getFlag: () => undefined } })

    const answer = await handlers.get(FEEDBACK_PREPARE_RPC_METHOD)?.({})

    expect(answer).toMatchObject({ kind: "unavailable" })
  })

  test("#given a session with a key in it and a memory entry #when the desktop prepares and submits #then one report is sent with the key removed, the desktop's logs included and no memory", async () => {
    const { pi, api, handlers, component, sent } = host({ withRedactor: true })
    await component.register(api, { logger: console, config: { getFlag: () => undefined } })
    await pi.dispatch("session_start", {}, sessionCtx)

    const draft = (await handlers.get(FEEDBACK_PREPARE_RPC_METHOD)?.({
      accessToken: "at_1",
      sections: [{ id: "logs", text: "desktop-main: renderer crashed, token sk-zzzzzzzzzzzz" }],
    })) as { draftId: string; sections: { id: string; text: string }[] }
    const result = await handlers.get(FEEDBACK_SUBMIT_RPC_METHOD)?.({ draftId: draft.draftId, kind: "bug", description: "it froze", accessToken: "at_1" })

    expect(result).toEqual({ kind: "sent", reportId: "rpt_9" })
    expect(sent).toHaveLength(1)
    const body = sent[0] ?? ""
    expect(body).not.toContain("sk-abcdefghijkl")
    expect(body).not.toContain("sk-zzzzzzzzzzzz")
    expect(body).not.toContain("private memory note")
    const ids = JSON.parse(body).sections.map((section: { id: string }) => section.id)
    expect(ids).toEqual(expect.arrayContaining(["description", "identity", "environment", "session", "logs", "config"]))
    expect(body).toContain("renderer crashed")
  })

  test("#given a draft that was already submitted #when it is submitted again #then nothing more is sent", async () => {
    const { pi, api, handlers, component, sent } = host({ withRedactor: true })
    await component.register(api, { logger: console, config: { getFlag: () => undefined } })
    await pi.dispatch("session_start", {}, sessionCtx)
    const draft = (await handlers.get(FEEDBACK_PREPARE_RPC_METHOD)?.({})) as { draftId: string }

    await handlers.get(FEEDBACK_SUBMIT_RPC_METHOD)?.({ draftId: draft.draftId, description: "a" })
    const second = await handlers.get(FEEDBACK_SUBMIT_RPC_METHOD)?.({ draftId: draft.draftId, description: "a" })

    expect(sent).toHaveLength(1)
    expect(second).toEqual({ kind: "refused", reason: "unavailable" })
  })

  test("#given the TUI #when the user runs /feedback with a description and chooses Send #then the same core sends one report and the user sees the report id", async () => {
    const { pi, api, component, sent } = host({ withRedactor: true })
    await component.register(api, { logger: console, config: { getFlag: () => undefined } })
    const notices: string[] = []
    const ctx = {
      ...sessionCtx,
      ui: {
        input: async () => undefined,
        select: async () => "Send report",
        notify: (message: string) => notices.push(message),
      },
    }

    const command = pi.commands.find((entry) => entry.name === "feedback")
    await (command?.options.handler as (args: string, ctx: unknown) => Promise<void>)("the answer stopped", ctx)

    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0] ?? "{}").sections[0]).toEqual({ id: "description", text: "the answer stopped" })
    expect(notices.at(-1)).toContain("rpt_9")
  })

  test("#given uploads are off and a custom agent dir #when a report is saved #then the file lands under that agent dir, never under HOME", async () => {
    const { pi, api, handlers, component, stateDir, homeDir } = host({ withRedactor: true, extraEnv: { OMO_DISABLE_FEEDBACK: "1" }, noStateDir: true })
    await component.register(api, { logger: console, config: { getFlag: () => undefined } })
    await pi.dispatch("session_start", {}, sessionCtx)
    const draft = (await handlers.get(FEEDBACK_PREPARE_RPC_METHOD)?.({})) as { draftId: string }

    const result = (await handlers.get(FEEDBACK_SUBMIT_RPC_METHOD)?.({ draftId: draft.draftId, description: "x" })) as { kind: string; path: string }

    expect(result.kind).toBe("saved")
    expect(result.path.startsWith(join(stateDir, "agent"))).toBe(true)
    expect(existsSync(join(homeDir, ".omo"))).toBe(false)
    expect(statSync(result.path).mode & 0o077).toBe(0)
    expect(noticeFor((await handlers.get(FEEDBACK_PREPARE_RPC_METHOD)?.({})) as FeedbackDraft)).not.toContain("logs")
  })

  test("#given recent engine log lines #when a report is prepared #then a logs section carries them and the TUI notice names logs", async () => {
    const { pi, api, handlers, component, stateDir } = host({ withRedactor: true })
    const logs = join(stateDir, "agent", "logs")
    mkdirSync(logs, { recursive: true })
    writeFileSync(join(logs, "session.log"), `${JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "turn_failed" })}\n`)
    await component.register(api, { logger: console, config: { getFlag: () => undefined } })
    await pi.dispatch("session_start", {}, sessionCtx)

    const draft = (await handlers.get(FEEDBACK_PREPARE_RPC_METHOD)?.({})) as { sections: { id: string; text: string }[] }

    expect(draft.sections.find((section) => section.id === "logs")?.text).toContain("turn_failed")
    expect(noticeFor(draft as unknown as FeedbackDraft)).toContain("recent logs")
    expect(readdirSync(logs)).toEqual(["session.log"])
  })
})
