import { randomUUID } from "node:crypto"

import type { ExtensionContext, SessionStartEvent } from "@code-yeongyu/senpi"

import type { ComponentContext, OmoSenpiComponent, SenpiExtensionAPI } from "../../extension/types"
import { getBuiltinSkillsRoot, getOmoNativeStateDir } from "../telemetry/product-identity"
import { readAgentEndOutcome } from "../ulw-execute-continuation/agent-end-eligibility"
import { loadOnboardingScanRuntime } from "./scan-component"
import type { OnboardingScanEvent } from "./scan-contract"
import type { OnboardingScanEnvironment } from "./scan-runtime"
import { registerSessionHistoryRpc } from "./session-history-rpc"
import { createOnboardingSessionHistoryTool } from "./session-history-tool"
import { claimOnboarding, completeOnboarding, isOnboardingComplete, releaseOnboarding, resetOnboarding } from "./state"
import { registerOnboardingStateRpc } from "./state-rpc"
import type { OnboardingUnderstandingSeams } from "./understand-start"
import { createOnboardingMemoryTools, type TuiOnboardingScan } from "./tui-memory-tools"

export interface OnboardingComponentDependencies {
  claimOnboarding(stateDir: string): boolean
  isOnboardingComplete(stateDir: string): boolean
  releaseOnboarding(stateDir: string): void
  /** Records a finished onboarding; omitted, a finished TUI turn records nothing (test fakes). */
  completeOnboarding?(stateDir: string): void
  /** Clears claim and completion for `omo.onboarding.state.reset`; defaults to `state.ts`. */
  resetOnboarding?(stateDir: string): void
  /** Where the migration inventory's scan reads; defaults to what `omo setup` reads. */
  readonly scanEnvironment?: () => OnboardingScanEnvironment
  /** The whole inventory source; defaults to the shared scan runtime `omo setup` uses. */
  readonly migrationFacts?: () => Promise<string | undefined>
  /** The whole scan; defaults to the shared onboarding scan. `undefined` onboards without one. */
  readonly scan?: () => Promise<TuiScanResult | undefined>
  /** Fake-model seams for the understanding the TUI runs. */
  readonly understanding?: OnboardingUnderstandingSeams
  /** Install-wide state dir; defaults to the engine's. */
  readonly stateDir?: string
}

export interface TuiScanResult extends TuiOnboardingScan {
  /** Scan rows and value summary, computed from this scan's events. */
  readonly context: string
  readonly inventory?: string
}

// The TUI reads this computer through the one shared scan (`omo setup`'s detection plus the engine
// session history, through the lazy onboarding-scan runtime), so it never grows a second reader.
// Fail-open: a scan that cannot run onboards the user without it.
async function defaultScan(environment: OnboardingScanEnvironment, stateDir: string): Promise<TuiScanResult> {
  const runtime = await loadOnboardingScanRuntime()
  const scanId = randomUUID()
  const events: OnboardingScanEvent[] = []
  const scanStateDir = environment.stateDir ?? (environment.env === undefined ? stateDir : getOmoNativeStateDir(environment.env))
  const { results } = await runtime.runOnboardingScan({ ...environment, stateDir: scanStateDir }, { scanId, includeCustomProviders: true }, (event) => { events.push(event) })
  const inventory = runtime.migrationFactsFromScan(results)
  return {
    scanId,
    stateDir: scanStateDir,
    ...(environment.env === undefined ? {} : { env: environment.env }),
    context: runtime.onboardingScanContext(scanId, events),
    ...(inventory === undefined ? {} : { inventory }),
  }
}

const defaultDependencies: OnboardingComponentDependencies = {
  claimOnboarding,
  completeOnboarding,
  isOnboardingComplete,
  releaseOnboarding,
  resetOnboarding,
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
      const stateDir = dependencies.stateDir ?? getOmoNativeStateDir(process.env)
      const tour = `Follow ${getBuiltinSkillsRoot()}/onboarding/SKILL.md.`
      const scanEnvironment = dependencies.scanEnvironment ?? (() => ({}))
      // Started on the first onboarding turn, once per process: other sessions never pay for it.
      let scanned: Promise<TuiScanResult | undefined> | undefined
      const scan = (): Promise<TuiScanResult | undefined> => {
        scanned ??= (dependencies.scan ?? (() => defaultScan(scanEnvironment(), stateDir)))().catch(() => undefined)
        return scanned
      }
      // An injected inventory replaces the scan's; the default scan then never starts for it.
      const injectedFacts = dependencies.migrationFacts
      let injected: Promise<string | undefined> | undefined
      const withInventory = async (base: string): Promise<string> => {
        const result = injectedFacts !== undefined && dependencies.scan === undefined ? undefined : await scan()
        const facts = injectedFacts === undefined
          ? result?.inventory
          : await (injected ??= injectedFacts().catch(() => undefined))
        const parts = [base]
        if (facts !== undefined) parts.push(` Migration inventory (from the same scan omo setup runs): ${facts}`)
        if (result !== undefined) parts.push(`\n\n${result.context}`)
        return parts.join("")
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
      const memoryTools = createOnboardingMemoryTools({
        scan,
        loadRuntime: loadOnboardingScanRuntime,
        ...(dependencies.understanding === undefined ? {} : { seams: dependencies.understanding }),
      })
      pi.registerTool({ ...memoryTools.understand })
      pi.registerTool({ ...memoryTools.apply })
      registerOnboardingStateRpc(pi, {
        stateDir,
        completeOnboarding: dependencies.completeOnboarding ?? completeOnboarding,
        resetOnboarding: dependencies.resetOnboarding ?? resetOnboarding,
        onReset: () => { pending = undefined },
      })
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
        else {
          pending = null
          try {
            dependencies.completeOnboarding?.(stateDir)
          } catch {
            // Fail-open like the claim: the held claim still keeps this install from re-onboarding.
          }
        }
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
