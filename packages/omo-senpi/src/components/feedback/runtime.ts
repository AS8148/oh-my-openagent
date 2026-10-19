// Sidecar entry for /feedback, /bug and the `omo.feedback.*` RPCs, bundled as extensions/omo-feedback.js and
// imported through `#omo-feedback-runtime` on first use (see runtime-loader.ts). The entry bundle keeps only the
// command and RPC shells; collection, draft building, the draft store and the upload live here.

import { randomUUID } from "node:crypto"

import { collectHostSections, type HostSessionView } from "./collect-host"
import { buildDraft, type CollectedSection, type FeedbackDraft, type UploadRedactor } from "./draft"
import { feedbackUploadsDisabled, submitReport, type ReportClient, type ReportTransport, type SubmitResult } from "./submit"

const DRAFT_TTL_MS = 30 * 60 * 1000
const MAX_DRAFTS = 8

export interface FeedbackSessionLike {
  readonly cwd?: unknown
  readonly sessionManager?: { getSessionId?(): string; getBranch?(): readonly unknown[] }
  readonly model?: { readonly provider?: unknown; readonly id?: unknown }
}

export interface FeedbackCoreConfig {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly now: () => Date
  readonly omoVersion: string
  readonly senpiVersion: string
  readonly channel: string
  readonly stateDir: () => string
  readonly apiOrigin: () => string
  readonly transport: ReportTransport
}

export interface FeedbackCore {
  prepare(session: FeedbackSessionLike | undefined, input: unknown, redact: UploadRedactor): FeedbackDraft
  submit(input: unknown, redact: UploadRedactor): Promise<SubmitResult>
}

interface StoredDraft {
  readonly draft: FeedbackDraft
  readonly client: ReportClient
  readonly installHash?: string
  readonly sessionHash?: string
  readonly expiresAt: number
}

const sessionView = (ctx: FeedbackSessionLike | undefined): HostSessionView | undefined => {
  if (ctx?.sessionManager?.getBranch === undefined) return undefined
  let entries: readonly unknown[]
  try {
    entries = ctx.sessionManager.getBranch()
  } catch {
    return undefined
  }
  const provider = typeof ctx.model?.provider === "string" ? ctx.model.provider : undefined
  const id = typeof ctx.model?.id === "string" ? ctx.model.id : undefined
  return {
    entries,
    ...(typeof ctx.cwd === "string" ? { cwd: ctx.cwd } : {}),
    ...(ctx.sessionManager.getSessionId === undefined ? {} : { sessionId: ctx.sessionManager.getSessionId() }),
    ...(id === undefined ? {} : { model: provider === undefined ? id : `${provider}/${id}` }),
  }
}

const clientSections = (input: unknown): CollectedSection[] => {
  const raw: unknown = Reflect.get(Object(input), "sections")
  if (!Array.isArray(raw)) return []
  const allowed = new Set(["logs", "crash"])
  return raw.flatMap((entry: unknown) => {
    const id: unknown = Reflect.get(Object(entry), "id")
    const text: unknown = Reflect.get(Object(entry), "text")
    if (typeof id !== "string" || !allowed.has(id) || typeof text !== "string") return []
    return [{ id: id as CollectedSection["id"], text }]
  })
}

const ID_VALUE = /^[A-Za-z0-9_.:@-]{1,128}$/
const EMAIL_VALUE = /^[^\s@]{1,64}@[^\s@]{1,190}$/
const IDENTITY_FIELDS = [
  ["account", "accountId", "id"],
  ["user", "userId", "id"],
  ["email", "email", "email"],
  ["name", "displayName", "free"],
  ["plan", "plan", "id"],
  ["device", "deviceId", "id"],
  ["device name", "deviceName", "free"],
] as const

const singleLine = (value: string): string | undefined => {
  const line = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()
  return line === "" || line.length > 120 ? undefined : line
}

/**
 * Builds the desktop's identity lines from named fields only. Every value goes through the upload redactor and is
 * dropped when the redactor finds anything in it; ids and the email must also match their shape. The email is checked
 * as its two halves so the redactor's own email rule does not remove the address we are collecting on purpose.
 */
export const clientIdentityLines = (input: unknown, redact: UploadRedactor): readonly string[] => {
  const identity: unknown = Reflect.get(Object(input), "identity")
  if (identity === null || typeof identity !== "object") return []
  const clean = (value: string): boolean => redact(value).count === 0
  return IDENTITY_FIELDS.flatMap(([label, key, shape]) => {
    const value: unknown = Reflect.get(identity, key)
    if (typeof value !== "string") return []
    if (shape === "id") return ID_VALUE.test(value) && clean(value) ? [`${label.padEnd(12)}${value}`] : []
    if (shape === "email") {
      if (!EMAIL_VALUE.test(value)) return []
      const at = value.lastIndexOf("@")
      return clean(value.slice(0, at)) && clean(value.slice(at + 1)) ? [`${label.padEnd(12)}${value}`] : []
    }
    const line = singleLine(value)
    return line !== undefined && clean(line) ? [`${label.padEnd(12)}${line}`] : []
  })
}

const mergeSections = (host: readonly CollectedSection[], client: readonly CollectedSection[], identityLines: readonly string[]): CollectedSection[] => {
  const merged = new Map(host.map((section) => [section.id, section]))
  for (const section of client) {
    const existing = merged.get(section.id)
    merged.set(section.id, existing === undefined ? section : { ...section, text: `${section.text}\n${existing.text}` })
  }
  if (identityLines.length > 0) {
    const existing = merged.get("identity")
    merged.set("identity", { id: "identity", verbatim: true, text: [...identityLines, ...(existing === undefined ? [] : [existing.text])].join("\n") })
  }
  return [...merged.values()]
}

export function createFeedbackCore(config: FeedbackCoreConfig): FeedbackCore {
  const { env, now, omoVersion, senpiVersion, channel } = config
  const drafts = new Map<string, StoredDraft>()

  const prepare = (session: FeedbackSessionLike | undefined, input: unknown, redact: UploadRedactor): FeedbackDraft => {
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
      collected: mergeSections(host.sections, clientSections(input), clientIdentityLines(input, redact)),
      redact,
      destination: feedbackUploadsDisabled(env) ? "local" : "intake",
      signedIn,
    })
    for (const [id, stored] of drafts) if (stored.expiresAt < now().getTime()) drafts.delete(id)
    while (drafts.size >= MAX_DRAFTS) {
      const oldest = drafts.keys().next().value
      if (oldest === undefined) break
      drafts.delete(oldest)
    }
    drafts.set(draft.draftId, {
      draft,
      client: { app: env.OMO_NATIVE_SURFACE === "desktop" ? "desktop" : "cli", omo: omoVersion, senpi: senpiVersion, os: process.platform, arch: process.arch, locale: Intl.DateTimeFormat().resolvedOptions().locale, channel },
      ...(host.installHash === undefined ? {} : { installHash: host.installHash }),
      ...(host.sessionHash === undefined ? {} : { sessionHash: host.sessionHash }),
      expiresAt: now().getTime() + DRAFT_TTL_MS,
    })
    return draft
  }

  const submit = async (input: unknown, redact: UploadRedactor): Promise<SubmitResult> => {
    const draftId: unknown = Reflect.get(Object(input), "draftId")
    const stored = typeof draftId === "string" ? drafts.get(draftId) : undefined
    if (stored === undefined) return { kind: "refused", reason: "unavailable" }
    const kind: unknown = Reflect.get(Object(input), "kind")
    const description: unknown = Reflect.get(Object(input), "description")
    const accessToken: unknown = Reflect.get(Object(input), "accessToken")
    const idempotencyKey: unknown = Reflect.get(Object(input), "idempotencyKey")
    const result = await submitReport({
      draft: stored.draft,
      kind: kind === "feedback" || kind === "other" ? kind : "bug",
      description: typeof description === "string" ? description : "",
      redact,
      client: stored.client,
      env,
      stateDir: config.stateDir(),
      apiOrigin: config.apiOrigin(),
      accessToken: typeof accessToken === "string" ? accessToken : null,
      transport: config.transport,
      ...(stored.installHash === undefined ? {} : { installHash: stored.installHash }),
      ...(stored.sessionHash === undefined ? {} : { sessionHash: stored.sessionHash }),
      ...(typeof idempotencyKey === "string" ? { idempotencyKey } : {}),
    })
    if (result.kind !== "refused" || result.reason === "secret-detected" || result.reason === "too-large") drafts.delete(stored.draft.draftId)
    return result
  }

  return { prepare, submit }
}
