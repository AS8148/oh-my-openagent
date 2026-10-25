import type { ComponentLogger, SenpiExtensionAPI, SettleObserver } from "./types"

type Handler = Parameters<SenpiExtensionAPI["on"]>[1]
const SETTLE_OBSERVER_BUDGET_MS = 2_000

/**
 * A settle subscription owns observation, not the work it observes. Expiry or retirement
 * stops new phases; it never terminalizes a reflection or signals its child. Durable writes
 * admitted before cancellation finish under their existing locks and remain identity-owned.
 * Their promises stay observed even after the host is released. The next settle retries
 * incomplete bookkeeping from durable state instead of reusing a retired event context.
 */
export function createSettleObservers(pi: SenpiExtensionAPI, logger: ComponentLogger) {
  const pending = new Map<AbortController, string | undefined>()
  const retire: Handler = (_event, ctx) => {
    const sessionId = readSessionId(ctx)
    for (const [controller, owner] of pending) {
      if (sessionId === undefined || owner === sessionId) {
        controller.abort(new DOMException("Settle observer retired", "AbortError"))
      }
    }
  }
  pi.on("session_shutdown", retire)
  pi.on("session_start", retire)

  return {
    wrap(component: string, hookLabel: string, handler: Handler): Handler {
      return async (payload, ctx) => {
        const controller = new AbortController()
        const { signal } = controller
        const sessionId = readSessionId(ctx)
        const started = Date.now()
        let hook = hookLabel
        const observer: SettleObserver = {
          signal,
          phase(label) {
            signal.throwIfAborted()
            hook = label
          },
        }
        pending.set(controller, sessionId)
        const released = Promise.withResolvers<undefined>()
        const onAbort = () => released.resolve(undefined)
        signal.addEventListener("abort", onAbort, { once: true })
        const timer = setTimeout(() => {
          logger.warn("extension_handler_stalled", {
            event: "extension_handler_stalled", extension: "omo.js",
            component, hook, handlerEvent: "agent_settled", stage: "timeout",
            durationMs: Date.now() - started, sessionId,
          })
          controller.abort(new DOMException("Settle observer budget exhausted", "TimeoutError"))
        }, SETTLE_OBSERVER_BUDGET_MS)
        const work = Promise.resolve().then(() => handler(payload, ctx, observer)).catch((error: unknown) => {
          if (!signal.aborted) throw error
          return undefined
        })
        try {
          return await Promise.race([work, released.promise])
        } finally {
          clearTimeout(timer)
          signal.removeEventListener("abort", onAbort)
          pending.delete(controller)
        }
      }
    },
  }
}

function readSessionId(ctx: unknown): string | undefined {
  if (typeof ctx !== "object" || ctx === null) return undefined
  const manager: unknown = Reflect.get(ctx, "sessionManager")
  if (typeof manager !== "object" || manager === null) return undefined
  const getter: unknown = Reflect.get(manager, "getSessionId")
  if (typeof getter !== "function") return undefined
  const id: unknown = Reflect.apply(getter, manager, [])
  return typeof id === "string" ? id : undefined
}
