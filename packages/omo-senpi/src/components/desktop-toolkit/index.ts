import { isAbsolute } from "node:path"

import type { ComponentContext, OmoSenpiComponent, SenpiExtensionAPI } from "../../extension/types"
import { callThreadTool, listThreadTools } from "./thread-tools"

export const DESKTOP_TOOLKIT_TOOL_NAME = "omo_desktop_toolkit"
export const TOOLKIT_REQUEST_EVENT = "omo.toolkit.request"
export const TOOLKIT_GRANT_RPC = "omo.toolkit.grant"
export const TOOLKITS_CONTEXT_KEY = "omo_toolkits"
const DEFAULT_ACQUIRE_TIMEOUT_MS = 15_000

const PARAMETERS = {
  type: "object",
  properties: {
    op: { type: "string", enum: ["acquire"] },
    toolkit: { type: "string" },
  },
  required: ["op", "toolkit"],
  additionalProperties: false,
} as const

/** What the app hands one session for one toolkit. The token stays in the file, never in a tool result. */
export interface ToolkitGrant {
  readonly endpoint: string
  readonly tokenFile: string
}

type Settled = { readonly ok: true; readonly grant: ToolkitGrant } | { readonly ok: false; readonly reason: string }

function reply(details: Settled) {
  return { content: [{ type: "text", text: JSON.stringify(details) }], details }
}

function offeredToolkits(sessionContext: unknown): ReadonlySet<string> {
  if (typeof sessionContext !== "object" || sessionContext === null) return new Set()
  const raw = (sessionContext as Record<string, unknown>)[TOOLKITS_CONTEXT_KEY]
  if (typeof raw !== "string") return new Set()
  return new Set(raw.split(",").map((name) => name.trim()).filter((name) => name.length > 0))
}

function parseGrant(value: unknown): ToolkitGrant | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const { endpoint, tokenFile } = value as Record<string, unknown>
  if (typeof endpoint !== "string" || typeof tokenFile !== "string" || !isAbsolute(tokenFile)) return undefined
  try {
    const url = new URL(endpoint)
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username !== "" || url.password !== "" || url.search !== "") return undefined
  } catch {
    return undefined
  }
  return { endpoint, tokenFile }
}

function callingSessionId(context: unknown): string | undefined {
  if (typeof context !== "object" || context === null || !("sessionManager" in context)) return undefined
  const manager = context.sessionManager
  if (typeof manager !== "object" || manager === null || !("getSessionId" in manager) || typeof manager.getSessionId !== "function") return undefined
  const id: unknown = manager.getSessionId()
  return typeof id === "string" && id.length > 0 ? id : undefined
}

/** Asks the app for a toolkit it hosts for this session's thread; only toolkits listed in `omo_toolkits` are requested. */
export function createDesktopToolkitComponent(options: { readonly timeoutMs?: number } = {}): OmoSenpiComponent {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS
  return {
    name: "desktop-toolkit",
    register(pi: SenpiExtensionAPI, ctx: ComponentContext): void {
      if (typeof pi.registerTool !== "function") return
      const pending = new Map<string, (settled: Settled) => void>()
      const attempted = new Set<string>()
      const grants = new Map<string, ToolkitGrant>()
      const registered = new Set<string>()

      async function acquire(toolkit: string): Promise<Settled> {
        if (pi.rpc === undefined || !offeredToolkits(pi.sessionContext).has(toolkit)) {
          return { ok: false, reason: "unavailable" }
        }
        const requestId = crypto.randomUUID()
        return new Promise<Settled>((resolve) => {
          const timer = setTimeout(() => {
            pending.delete(requestId)
            resolve({ ok: false, reason: "timeout" })
          }, timeoutMs)
          pending.set(requestId, (value) => {
            clearTimeout(timer)
            pending.delete(requestId)
            resolve(value)
          })
          pi.rpc?.emit(TOOLKIT_REQUEST_EVENT, { requestId, toolkit })
        })
      }

      pi.registerTool({
        name: DESKTOP_TOOLKIT_TOOL_NAME,
        label: "Desktop toolkit",
        description:
          "Internal channel for skills: ask the app for a toolkit it hosts for this thread, such as its in-app browser. Not for direct use.",
        parameters: PARAMETERS,
        exposure: "eval",
        permissionParser: () => [],
        executionMode: "parallel",
        async execute(_toolCallId: string, params: { readonly op?: unknown; readonly toolkit?: unknown }) {
          const toolkit = typeof params.toolkit === "string" ? params.toolkit : ""
          if (params.op !== "acquire" || toolkit === "") return reply({ ok: false, reason: "invalid_request" })
          return reply(await acquire(toolkit))
        },
      })

      pi.rpc?.handle?.(TOOLKIT_GRANT_RPC, (data: unknown) => {
        const message = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {}
        const settle = typeof message.requestId === "string" ? pending.get(message.requestId) : undefined
        if (settle === undefined) return { accepted: false }
        const grant = parseGrant(message.grant)
        if (grant !== undefined) {
          settle({ ok: true, grant })
          return { accepted: true }
        }
        const refusal = message.refusal
        const reason =
          typeof refusal === "object" && refusal !== null && typeof (refusal as Record<string, unknown>).reason === "string"
            ? String((refusal as Record<string, unknown>).reason)
            : "invalid_grant"
        settle({ ok: false, reason })
        return { accepted: true }
      })

      pi.on("session_start", async (_event, eventCtx) => {
        if (pi.rpc === undefined || !offeredToolkits(pi.sessionContext).has("thread")) {
          ctx.logger.debug?.("desktop thread toolkit unavailable", { reason: "not_offered" })
          return
        }
        const sessionId = callingSessionId(eventCtx)
        if (sessionId === undefined) {
          ctx.logger.info("desktop thread toolkit unavailable", { reason: "missing_session" })
          return
        }
        if (attempted.has(sessionId)) return
        attempted.add(sessionId)
        try {
          const settled = await acquire("thread")
          if (!settled.ok) {
            ctx.logger.info("desktop thread toolkit unavailable", { reason: settled.reason === "timeout" ? "timeout" : "grant_refused" })
            return
          }
          const tools = await listThreadTools(settled.grant, timeoutMs)
          grants.set(sessionId, settled.grant)
          for (const tool of tools) {
            const name = `desktop_${tool.name}`
            if (registered.has(name)) continue
            pi.registerTool({
              name,
              label: name,
              description: tool.description ?? "",
              parameters: tool.inputSchema,
              async execute(_id: string, args: Record<string, unknown>, signal?: AbortSignal, _onUpdate?: unknown, callCtx?: unknown) {
                const caller = callingSessionId(callCtx)
                // Never substitute the registering session when the caller has no grant.
                const grant = caller === undefined ? undefined : grants.get(caller)
                return callThreadTool(grant, tool.name, args, timeoutMs, signal)
              },
            })
            registered.add(name)
          }
        } catch {
          // Remote errors may echo the bearer. Only a fixed diagnostic crosses this boundary.
          ctx.logger.info("desktop thread toolkit unavailable", { reason: "discovery_failed" })
        }
      })
    },
  }
}
