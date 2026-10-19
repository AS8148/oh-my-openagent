import { randomUUID } from "node:crypto"

import type { OmoSenpiComponent, SenpiExtensionAPI } from "../../extension/types"
import { createOmoNativeProductConfig } from "../telemetry/product-identity"
import { collectHostSections, type HostSessionView } from "./collect-host"
import { buildDraft, type CollectedSection, type FeedbackDraft, type FeedbackKind, type UploadRedactor } from "./draft"
import { feedbackUploadsDisabled, submitReport, type ReportClient, type ReportTransport, type SubmitResult } from "./submit"

export const FEEDBACK_PREPARE_RPC_METHOD = "omo.feedback.prepare"
export const FEEDBACK_SUBMIT_RPC_METHOD = "omo.feedback.submit"
const DRAFT_TTL_MS = 30 * 60 * 1000
const DEFAULT_API_ORIGIN = "https://api.omo.dev"

export interface FeedbackComponentOptions {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly transport?: ReportTransport
  readonly stateDir?: string
  readonly omoVersion?: string
  readonly senpiVersion?: string
  readonly channel?: string
  readonly now?: () => Date
}

interface SessionLike {
  readonly cwd?: unknown
  readonly sessionManager?: { getSessionId?(): string; getBranch?(): readonly unknown[] }
  readonly model?: { readonly provider?: unknown; readonly id?: unknown }
}

interface StoredDraft {
  readonly draft: FeedbackDraft
  readonly client: ReportClient
  readonly installHash?: string
  readonly sessionHash?: string
  readonly expiresAt: number
}

const sessionView = (ctx: SessionLike | undefined): HostSessionView | undefined => {
  if (ctx?.sessionManager?.getBranch === undefined) return undefined
  const provider = typeof ctx.model?.provider === "string" ? ctx.model.provider : undefined
  const id = typeof ctx.model?.id === "string" ? ctx.model.id : undefined
  return {
    entries: ctx.sessionManager.getBranch(),
    ...(typeof ctx.cwd === "string" ? { cwd: ctx.cwd } : {}),
    ...(ctx.sessionManager.getSessionId === undefined ? {} : { sessionId: ctx.sessionManager.getSessionId() }),
    ...(id === undefined ? {} : { model: provider === undefined ? id : `${provider}/${id}` }),
  }
}

const hostRedactor = (pi: SenpiExtensionAPI): UploadRedactor | undefined => {
  const redact = pi.redactForUpload
  if (redact === undefined) return undefined
  return (text) => {
    const result = redact(text)
    return { text: result.text, count: Object.values(result.counts).reduce((sum, n) => sum + n, 0) }
  }
}

const clientSections = (input: unknown): CollectedSection[] => {
  const raw: unknown = Reflect.get(Object(input), "sections")
  if (!Array.isArray(raw)) return []
  const allowed = new Set(["logs", "crash", "identity"])
  return raw.flatMap((entry: unknown) => {
    const id: unknown = Reflect.get(Object(entry), "id")
    const text: unknown = Reflect.get(Object(entry), "text")
    if (typeof id !== "string" || !allowed.has(id) || typeof text !== "string") return []
    return [{ id: id as CollectedSection["id"], text, ...(id === "identity" ? { verbatim: true } : {}) }]
  })
}

const mergeSections = (host: readonly CollectedSection[], client: readonly CollectedSection[]): CollectedSection[] => {
  const merged = new Map(host.map((section) => [section.id, section]))
  for (const section of client) {
    const existing = merged.get(section.id)
    merged.set(section.id, existing === undefined ? section : { ...section, text: `${section.text}\n${existing.text}` })
  }
  return [...merged.values()]
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
      const drafts = new Map<string, StoredDraft>()
      let lastSession: SessionLike | undefined
      pi.on("session_start", (_payload, ctx) => {
        lastSession = ctx as SessionLike | undefined
      })

      const prepare = (session: SessionLike | undefined, input: unknown): FeedbackDraft | { kind: "unavailable"; reason: string } => {
        const redact = hostRedactor(pi)
        if (redact === undefined) return { kind: "unavailable", reason: FEEDBACK_UNAVAILABLE }
        const host = collectHostSections({
          env,
          omoVersion,
          senpiVersion,
          channel,
          now: now(),
          ...(sessionView(session) === undefined ? {} : { session: sessionView(session) }),
        })
        const signedIn = typeof Reflect.get(Object(input), "accessToken") === "string"
        const draft = buildDraft({
          draftId: `drf_${randomUUID()}`,
          collected: mergeSections(host.sections, clientSections(input)),
          redact,
          destination: feedbackUploadsDisabled(env) ? "local" : "intake",
          signedIn,
        })
        for (const [id, stored] of drafts) if (stored.expiresAt < now().getTime()) drafts.delete(id)
        drafts.set(draft.draftId, {
          draft,
          client: { app: env.OMO_NATIVE_SURFACE === "desktop" ? "desktop" : "cli", omo: omoVersion, senpi: senpiVersion, os: process.platform, arch: process.arch, locale: Intl.DateTimeFormat().resolvedOptions().locale, channel },
          ...(host.installHash === undefined ? {} : { installHash: host.installHash }),
          ...(host.sessionHash === undefined ? {} : { sessionHash: host.sessionHash }),
          expiresAt: now().getTime() + DRAFT_TTL_MS,
        })
        return draft
      }

      const submit = async (input: unknown): Promise<SubmitResult> => {
        const draftId: unknown = Reflect.get(Object(input), "draftId")
        const stored = typeof draftId === "string" ? drafts.get(draftId) : undefined
        const redact = hostRedactor(pi)
        if (stored === undefined || redact === undefined) return { kind: "refused", reason: "unavailable" }
        drafts.delete(stored.draft.draftId)
        const kind: unknown = Reflect.get(Object(input), "kind")
        const description: unknown = Reflect.get(Object(input), "description")
        const accessToken: unknown = Reflect.get(Object(input), "accessToken")
        return submitReport({
          draft: stored.draft,
          kind: kind === "feedback" || kind === "other" ? kind : "bug",
          description: typeof description === "string" ? description : "",
          redact,
          client: stored.client,
          env,
          stateDir: options.stateDir ?? `${env.HOME ?? ""}/.omo/agent/omo-senpi`,
          apiOrigin: env.OMO_SERVICE_API_URL ?? DEFAULT_API_ORIGIN,
          accessToken: typeof accessToken === "string" ? accessToken : null,
          transport: options.transport ?? ((url, init) => fetch(url, init)),
          ...(stored.installHash === undefined ? {} : { installHash: stored.installHash }),
          ...(stored.sessionHash === undefined ? {} : { sessionHash: stored.sessionHash }),
        })
      }

      pi.rpc?.handle?.(FEEDBACK_PREPARE_RPC_METHOD, (input) => prepare(lastSession, input))
      pi.rpc?.handle?.(FEEDBACK_SUBMIT_RPC_METHOD, submit)

      const runCommand = async (args: string, ctx: unknown): Promise<void> => {
        const ui = Reflect.get(Object(ctx), "ui") as
          | { input(title: string, placeholder?: string): Promise<string | undefined>; select(title: string, options: string[]): Promise<string | undefined>; notify(message: string, type?: string): void }
          | undefined
        if (ui === undefined) return
        const prepared = prepare(ctx as SessionLike, {})
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
        const result = await submit({ draftId: prepared.draftId, kind: "bug" satisfies FeedbackKind, description })
        ui.notify(resultMessage(result), result.kind === "refused" ? "error" : "info")
      }

      for (const name of ["feedback", "bug"]) {
        pi.registerCommand(name, {
          description: "Report a problem or send feedback to the OmO team",
          argumentHint: "[what went wrong]",
          handler: runCommand,
        })
      }
    },
  }
}

export function noticeFor(draft: FeedbackDraft): string {
  const included = "your account, this device, app versions, this conversation's recent messages, recent logs and crash reports, and your settings"
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
    case "refused":
      return {
        "secret-detected": "The report still looked like it contained a password or key, so nothing was sent. Remove it from the description and try again.",
        "too-large": "The report is too large to send. Try again from a shorter conversation.",
        "rate-limited": "Too many reports in a short time. Try again in a few minutes.",
        unavailable: "The report could not be sent right now. Check your connection and try again.",
      }[result.reason]
  }
}
