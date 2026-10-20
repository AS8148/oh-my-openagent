import type { ExtensionContext, SessionStartEvent } from "@code-yeongyu/senpi"

import type { ComponentContext, OmoSenpiComponent, SenpiExtensionAPI } from "../../extension/types"
import { getBuiltinSkillsRoot, getOmoNativeStateDir } from "../telemetry/product-identity"
import { readAgentEndOutcome } from "../ulw-execute-continuation/agent-end-eligibility"
import { loadOnboardingScanRuntime } from "./scan-component"
import type { OnboardingScanEnvironment } from "./scan-runtime"
import { registerSessionHistoryRpc } from "./session-history-rpc"
import { createOnboardingSessionHistoryTool } from "./session-history-tool"
import { claimOnboarding, isOnboardingComplete, releaseOnboarding } from "./state"

export interface OnboardingComponentDependencies {
  claimOnboarding(stateDir: string): boolean
  isOnboardingComplete(stateDir: string): boolean
  releaseOnboarding(stateDir: string): void
  /** Where the migration inventory's scan reads; defaults to what `omo setup` reads. */
  readonly scanEnvironment?: () => OnboardingScanEnvironment
  /** The whole inventory source; defaults to the shared scan runtime `omo setup` uses. */
  readonly migrationFacts?: () => Promise<string | undefined>
  /** The bounded background summary of this machine's agent sessions; defaults to the scan runtime's. */
  readonly sessionHistory?: () => Promise<string | undefined>
}

// The migration inventory comes from the one shared scan (`omo setup`'s own detection, through the
// lazy onboarding-scan runtime), so the TUI never grows a second config reader. Fail-open: a scan
// that cannot run onboards the user without an inventory.
async function defaultMigrationFacts(environment: () => OnboardingScanEnvironment): Promise<string | undefined> {
  const runtime = await loadOnboardingScanRuntime()
  const { results } = await runtime.runOnboardingScan(environment(), { scanId: "onboarding-tui", includeCustomProviders: true, sessions: false }, () => {})
  return runtime.migrationFactsFromScan(results)
}

const defaultDependencies: OnboardingComponentDependencies = {
  claimOnboarding,
  isOnboardingComplete,
  releaseOnboarding,
}

export function isSessionStartEvent(v: unknown): v is SessionStartEvent {
  return isRecord(v) && "reason" in v
}

export function isExtensionContext(v: unknown): v is ExtensionContext {
  return isRecord(v) && "ui" in v
}

export function createOnboardingComponent(
  dependencies: OnboardingComponentDependencies = defaultDependencies,
): OmoSenpiComponent {
  const forcedKey = Symbol.for("omo.onboard")
  const processState = globalThis as { [forcedKey]?: boolean }
  return {
    name: "onboarding",
    register(pi: SenpiExtensionAPI, _ctx: ComponentContext): void {
      const stateDir = getOmoNativeStateDir(process.env)
      const tour = `Follow ${getBuiltinSkillsRoot()}/onboarding/SKILL.md.`
      const scanEnvironment = dependencies.scanEnvironment ?? (() => ({}))
      // The inventory loads lazily (#10478): the scan runs once, only after a claim actually succeeds
      // - never at register(), so sessions that never onboard pay none of its cost.
      let migrationInventory: Promise<string | undefined> | undefined
      let history: Promise<void> | undefined
      const withInventory = async (base: string): Promise<string> => {
        // Session history is never awaited here: it starts with the claim, runs bounded in the
        // background and rides the next turn when it lands; a hang or failure just leaves it out.
        history ??= (dependencies.sessionHistory
          ?? (async () => (await loadOnboardingScanRuntime()).onboardingHistorySummary(scanEnvironment())))()
          .then((content) => {
            if (content !== undefined && pending !== undefined) {
              return pi.sendMessage({ customType: "omo-onboarding:history", content, display: false }, { deliverAs: "nextTurn" })
            }
          })
          .catch(() => undefined)
        migrationInventory ??= (dependencies.migrationFacts ?? (() => defaultMigrationFacts(scanEnvironment)))().catch(() => undefined)
        const facts = await migrationInventory
        return facts === undefined ? base : `${base} Migration inventory (from the same scan omo setup runs): ${facts}`
      }
      const force = () => pi.getFlag("onboard") === true && !processState[forcedKey]
      // Undefined is unclaimed; null is a successfully completed onboarding turn.
      let pending: {
        id: string
        owned: boolean
        active: boolean
        end?: unknown
      } | null | undefined

      const eligible = (ctx: unknown): ctx is ExtensionContext =>
        isExtensionContext(ctx) && ctx.hasUI && pi.sessionKind === "interactive"
        && pi.getFlag("omo-senpi-onboarding-disabled") !== true

      const showWelcome = (ctx: ExtensionContext): void => {
        if (ctx.mode !== "tui") return
        ctx.ui.setWidget("omo-onboarding", [
          "Welcome to OmO. Ask anything.",
          "Use ulw for full workflows.",
        ])
      }
      const ownsRun = (ctx: unknown): ctx is ExtensionContext =>
        isExtensionContext(ctx) && pending != null
        && ctx.sessionManager.getSessionId() === pending.id

      const release = (ctx: ExtensionContext): void => {
        if (pending?.owned) dependencies.releaseOnboarding(stateDir)
        pending = undefined
        if (eligible(ctx) && !dependencies.isOnboardingComplete(stateDir)) showWelcome(ctx)
      }
      const claim = (ctx: ExtensionContext, forced: boolean): boolean => {
        if (pending !== undefined) return false
        const owned = dependencies.claimOnboarding(stateDir)
        if (!owned && !forced) return false
        processState[forcedKey] ||= forced
        pending = { id: ctx.sessionManager.getSessionId(), owned, active: false }
        if (ctx.mode === "tui") ctx.ui.setWidget("omo-onboarding", undefined)
        return true
      }

      pi.registerTool({ ...createOnboardingSessionHistoryTool({ stateDir }) })
      registerSessionHistoryRpc(pi)

      pi.registerFlag("onboard", {
        type: "boolean",
        default: false,
        description: "Start the guided tour.",
      })

      pi.on("session_start", async (event, ctx) => {
        if (!isSessionStartEvent(event) || event.reason !== "startup"
          || !eligible(ctx) || ctx.mode !== "tui") return
        if (!force()) {
          if (!dependencies.isOnboardingComplete(stateDir)) showWelcome(ctx)
          return
        }
        if (!claim(ctx, true)) return
        try {
          await pi.sendMessage({
            customType: "omo-onboarding:bootstrap",
            content: await withInventory(`${tour} Greet first.`),
            display: false,
          }, { triggerTurn: true, deliverAs: "followUp" })
        } catch (error) {
          release(ctx)
          throw error
        }
      })

      // Deliberately not previewSafe: previews must never acquire install-wide state.
      pi.on("before_agent_start", async (event, ctx) => {
        if (!isRecord(event) || event.trigger !== "prompt" || event.preview === true || !eligible(ctx)) return
        const forced = force()
        if (!claim(ctx, forced)) return
        if (ctx.sessionManager.getBranch().some((entry) =>
          entry.type === "custom_message" && entry.customType === "omo-onboarding:context")) return
        return {
          message: {
            customType: "omo-onboarding:context",
            display: false,
            content: await withInventory(forced
              ? `${tour} Tour using their message.`
              : `Answer fully; greet in their language; offer a one-line tour. On request/acceptance: ${tour}`),
          },
        }
      })

      pi.on("agent_start", (_event, ctx) => {
        if (ownsRun(ctx) && pending) {
          pending.active = true
          pending.end = undefined
        }
      })
      pi.on("agent_end", (event, ctx) => {
        if (!ownsRun(ctx) || !pending?.active) return
        pending.end = event
        const outcome = readAgentEndOutcome(event)
        if (!outcome.willRetry && outcome.blockedBy !== null) release(ctx)
      })
      pi.on("agent_settled", (_event, ctx) => {
        if (!ownsRun(ctx) || !pending?.active) return
        // The host can join a late user abort onto the same agent_end object.
        if (readAgentEndOutcome(pending.end).blockedBy !== null) release(ctx)
        else pending = null
      })
      pi.on("input_disposition", (event, ctx) => {
        if (ownsRun(ctx) && pending && !pending.active
          && isRecord(event) && event.disposition === "rejected") release(ctx)
      })
      for (const event of ["session_abort", "session_shutdown"]) {
        pi.on(event, (_event, ctx) => {
          if (ownsRun(ctx)) release(ctx)
        })
      }
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
