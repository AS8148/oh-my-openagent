import { join } from "node:path"

import type { OmoSenpiComponent, SenpiExtensionAPI } from "../../extension/types"
import { resolveAgentHome } from "../agent-home/resolve-agent-home"
import { createOmoNativeProductConfig } from "../telemetry/product-identity"
import type { FeedbackDraft, FeedbackKind, UploadRedactor } from "./draft"
import { feedbackRuntimeLoadFailure, loadFeedbackRuntime, type FeedbackRuntimeLoader } from "./runtime-loader"
import type { FeedbackCore, FeedbackSessionLike } from "./runtime"
import type { ReportTransport, SubmitResult } from "./submit"

export const FEEDBACK_PREPARE_RPC_METHOD = "omo.feedback.prepare"
export const FEEDBACK_SUBMIT_RPC_METHOD = "omo.feedback.submit"
const DEFAULT_API_ORIGIN = "https://api.omo.dev"

export interface FeedbackComponentOptions {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly transport?: ReportTransport
  readonly stateDir?: string
  readonly omoVersion?: string
  readonly senpiVersion?: string
  readonly channel?: string
  readonly now?: () => Date
  readonly loadRuntime?: FeedbackRuntimeLoader
}

type SessionLike = FeedbackSessionLike

const hostRedactor = (pi: SenpiExtensionAPI): UploadRedactor | undefined => {
  const redact = pi.redactForUpload
  if (redact === undefined) return undefined
  return (text) => {
    const result = redact(text)
    return { text: result.text, count: Object.values(result.counts).reduce((sum, n) => sum + n, 0) }
  }
}

const sessionIdOf = (ctx: SessionLike | undefined): string | undefined => {
  try {
    return ctx?.sessionManager?.getSessionId?.()
  } catch {
    return undefined
  }
}

export const FEEDBACK_UNAVAILABLE = "Feedback needs an OmO runtime that can remove secrets before upload. Update OmO and try again."

export function createFeedbackComponent(options: FeedbackComponentOptions = {}): OmoSenpiComponent {
  return {
    name: "feedback",
    register(pi) {
      const env = options.env ?? process.env
      const now = options.now ?? (() => new Date())
      const omoVersion = options.omoVersion ?? createOmoNativeProductConfig().packageVersion
      const senpiVersion = options.senpiVersion ?? pi.hostVersion ?? "unknown"
      const channel = options.channel ?? (omoVersion.includes("-") ? "beta" : "latest")
      const liveSessions = new Map<string, SessionLike>()
      let latestSessionId: string | undefined
      pi.on("session_start", (_payload, ctx) => {
        const id = sessionIdOf(ctx as SessionLike | undefined)
        if (id === undefined) return
        liveSessions.set(id, ctx as SessionLike)
        latestSessionId = id
      })
      pi.on("session_shutdown", (_payload, ctx) => {
        const id = sessionIdOf(ctx as SessionLike | undefined)
        if (id === undefined) return
        liveSessions.delete(id)
        if (latestSessionId === id) latestSessionId = [...liveSessions.keys()].at(-1)
      })
      const sessionForRpc = (input: unknown): SessionLike | undefined => {
        const requested: unknown = Reflect.get(Object(input), "sessionId")
        if (requested === null) return undefined
        if (typeof requested === "string") return liveSessions.get(requested)
        return latestSessionId === undefined ? undefined : liveSessions.get(latestSessionId)
      }

      const loadRuntime = options.loadRuntime ?? loadFeedbackRuntime
      let core: FeedbackCore | undefined
      const coreOf = async (): Promise<FeedbackCore> => {
        if (core !== undefined) return core
        let runtime
        try {
          runtime = await loadRuntime()
        } catch (error) {
          throw new Error(feedbackRuntimeLoadFailure(error))
        }
        core ??= runtime.createFeedbackCore({
          env,
          now,
          omoVersion,
          senpiVersion,
          channel,
          stateDir: () => options.stateDir ?? join(resolveAgentHome({ env }), "omo-senpi"),
          apiOrigin: () => env.OMO_SERVICE_API_URL ?? DEFAULT_API_ORIGIN,
          transport: options.transport ?? ((url, init) => fetch(url, init)),
        })
        return core
      }

      const prepare = async (session: SessionLike | undefined, input: unknown): Promise<FeedbackDraft | { kind: "unavailable"; reason: string }> => {
        const redact = hostRedactor(pi)
        if (redact === undefined) return { kind: "unavailable", reason: FEEDBACK_UNAVAILABLE }
        return (await coreOf()).prepare(session, input, redact)
      }

      const submit = async (input: unknown): Promise<SubmitResult> => {
        const redact = hostRedactor(pi)
        if (redact === undefined) return { kind: "refused", reason: "unavailable" }
        return (await coreOf()).submit(input, redact)
      }

      pi.rpc?.handle?.(FEEDBACK_PREPARE_RPC_METHOD, (input) => prepare(sessionForRpc(input), input))
      pi.rpc?.handle?.(FEEDBACK_SUBMIT_RPC_METHOD, submit)

      const runCommand = async (kind: FeedbackKind, args: string, ctx: unknown): Promise<void> => {
        const ui = Reflect.get(Object(ctx), "ui") as
          | { input(title: string, placeholder?: string): Promise<string | undefined>; select(title: string, options: string[]): Promise<string | undefined>; notify(message: string, type?: string): void }
          | undefined
        if (ui === undefined) return
        let prepared: Awaited<ReturnType<typeof prepare>>
        try {
          prepared = await prepare(ctx as SessionLike, {})
        } catch (error) {
          ui.notify(error instanceof Error ? error.message : String(error), "error")
          return
        }
        if ("kind" in prepared) {
          ui.notify(prepared.reason, "warning")
          return
        }
        const description = args.trim() !== "" ? args.trim() : await ui.input("What went wrong?", "What happened, and what did you expect?")
        if (description === undefined || description.trim() === "") return
        const notice = noticeFor(prepared)
        for (;;) {
          const choice = await ui.select(notice, ["Send report", "See exactly what is sent", "Cancel"])
          if (choice === "See exactly what is sent") {
            ui.notify(prepared.sections.filter((s) => s.id !== "description").map((s) => `## ${s.title}\n${s.text}`).join("\n\n"), "info")
            continue
          }
          if (choice !== "Send report") return
          break
        }
        const result = await submit({ draftId: prepared.draftId, kind, description })
        ui.notify(resultMessage(result), result.kind === "refused" ? "error" : "info")
      }

      pi.registerCommand("feedback", {
        description: "Send feedback or an idea to the OmO team",
        argumentHint: "[your feedback]",
        handler: (args: string, ctx: unknown) => runCommand("feedback", args, ctx),
      })
      pi.registerCommand("bug", {
        description: "Report a problem to the OmO team",
        argumentHint: "[what went wrong]",
        handler: (args: string, ctx: unknown) => runCommand("bug", args, ctx),
      })
    },
  }
}

const SECTION_PHRASES: Readonly<Partial<Record<string, string>>> = {
  identity: "your account and this device",
  environment: "app versions",
  session: "this conversation's recent messages",
  logs: "recent logs",
  crash: "crash reports",
  config: "your settings",
}

export function noticeFor(draft: FeedbackDraft): string {
  const phrases = draft.sections.flatMap((section) => {
    const phrase = SECTION_PHRASES[section.id]
    return phrase === undefined ? [] : [phrase]
  })
  const included = phrases.length <= 1 ? phrases.join("") : `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1) ?? ""}`
  return draft.destination === "intake"
    ? `Sending also includes ${included}. Passwords, keys and tokens are removed first, and your memory is never sent. Only the OmO team can read it; it is kept ${draft.retentionDays} days.`
    : `Uploads are turned off here (OMO_DISABLE_FEEDBACK), so the report, with ${included}, is saved as a file you can send yourself.`
}

export function resultMessage(result: SubmitResult): string {
  switch (result.kind) {
    case "sent":
      return `Thanks. Your report was sent (${result.reportId}).`
    case "saved":
      return `Uploads are off, so the report was saved to ${result.path}.`
    case "already-sent":
      return "Your earlier report already reached the OmO team, so it was not sent again."
    case "refused":
      return {
        "secret-detected": "The report still looked like it contained a password or key, so nothing was sent. Remove it from the description and try again.",
        "too-large": "The report is too large to send. Try again from a shorter conversation.",
        "rate-limited": "Too many reports in a short time. Try again in a few minutes.",
        unavailable: "The report could not be sent right now. Check your connection and try again.",
      }[result.reason]
  }
}
