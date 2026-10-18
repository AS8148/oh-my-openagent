import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import { createOnboardingComponent } from "./component"
import * as state from "./state"
import type { OmoSenpiComponent } from "../../extension/types"

class OnboardingAPI extends FakeExtensionAPI {
  sessionKind: "interactive" | "worker" = "interactive"
}

export function createOnboardingHarness(dir: string, sessionId = "session", mode = "rpc", component?: OmoSenpiComponent) {
  const pi = new OnboardingAPI()
  const rpcHandlers = new Map<string, (request: unknown) => unknown>()
  pi.rpc = {
    emit: (name: string, data: unknown) => { pi.rpcEvents.push({ name, data }) },
    handle: (name: string, handler: (request: unknown) => unknown) => { rpcHandlers.set(name, handler) },
  } as typeof pi.rpc
  const widgets = new Map<string, string[]>()
  const branch: Array<{ type: "custom_message"; customType: string; content: unknown }> = []
  const requests: typeof branch[] = []
  let queued: typeof branch = []
  const ctx = {
    hasUI: true,
    mode,
    sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
    ui: {
      setWidget(key: string, lines: string[] | undefined) {
        if (lines) widgets.set(key, lines)
        else widgets.delete(key)
      },
    },
  }
  const dependencies = {
    claimOnboarding: () => state.claimOnboarding(dir),
    isOnboardingComplete: () => state.isOnboardingComplete(dir),
    releaseOnboarding: () => state.releaseOnboarding(dir),
    completeOnboarding: () => state.completeOnboarding(dir),
    resetOnboarding: () => state.resetOnboarding(dir),
    scan: async () => undefined,
    stateDir: dir,
  }
  ;(component ?? createOnboardingComponent(dependencies)).register(pi, {
    logger: { info() {}, warn() {}, error() {} },
    config: { getFlag: () => false },
  })
  return {
    pi, ctx, widgets, branch, requests,
    rpc: async (name: string, request: unknown = {}) => {
      const handler = rpcHandlers.get(name)
      if (handler === undefined) throw new Error(`no rpc handler registered for ${name}`)
      return handler(request)
    },
    start: () => pi.dispatch("session_start", { type: "session_start", reason: "startup" }, ctx),
    prompt: async (overrides: Record<string, unknown> = {}) => {
      const results = await pi.dispatch("before_agent_start", {
        type: "before_agent_start", trigger: "prompt", prompt: "Fix the failing test", ...overrides,
      }, ctx)
      queued = results.flatMap((result) => {
        if (typeof result !== "object" || result === null || !("message" in result)) return []
        const message = result.message as { customType: string; content: unknown }
        return [{ type: "custom_message" as const, ...message }]
      })
      return results
    },
    agentStart: () => {
      branch.push(...queued)
      queued = []
      requests.push([...branch])
      return pi.dispatch("agent_start", { type: "agent_start" }, ctx)
    },
    end: (stopReason = "stop", overrides: Record<string, unknown> = {}) => pi.dispatch("agent_end", {
      type: "agent_end", messages: [{ role: "assistant", stopReason, content: [] }], ...overrides,
    }, ctx),
    settle: () => pi.dispatch("agent_settled", { type: "agent_settled" }, ctx),
  }
}
