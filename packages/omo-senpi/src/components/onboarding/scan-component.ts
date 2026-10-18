import { randomUUID } from "node:crypto"

import type { ComponentContext, OmoSenpiComponent, SenpiExtensionAPI } from "../../extension/types"
import { resolveMemoryModelRegistry, type ChildModelRegistry } from "../memory/model-registry-resolver"
import {
  ONBOARDING_APPLY_RPC_METHOD,
  ONBOARDING_APPLY_STAGES,
  ONBOARDING_SCAN_RPC_EVENT,
  ONBOARDING_SCAN_RPC_METHOD,
  type OnboardingApplyResponse,
  type OnboardingApplyStage,
  type OnboardingScanResponse,
} from "./scan-contract"
import type { applyOnboardingScan, migrationFactsFromScan, onboardingScanContext, OnboardingScanEnvironment, runOnboardingScan, runOnboardingUnderstanding } from "./scan-runtime"
import { registerOnboardingUnderstanding, type OnboardingUnderstandingSeams } from "./understand-component"

export * from "./scan-contract"
export * from "./understand-contract"

declare const OMO_SENPI_BUNDLED: boolean

/** The built runtime sits beside `omo.js`, so the entry bundle carries none of `omo setup`. */
export const ONBOARDING_SCAN_RUNTIME_FILE = "omo-onboarding-scan.js"
/** Finished scans an apply can still use; older ones answer `unavailable`. */
const RETAINED_SCANS = 8

export interface OnboardingScanRuntime {
  readonly runOnboardingScan: typeof runOnboardingScan
  readonly applyOnboardingScan: typeof applyOnboardingScan
  readonly migrationFactsFromScan: typeof migrationFactsFromScan
  readonly onboardingScanContext: typeof onboardingScanContext
  readonly runOnboardingUnderstanding: typeof runOnboardingUnderstanding
}

export interface OnboardingScanComponentDependencies {
  readonly runtime?: () => OnboardingScanEnvironment
  readonly loadRuntime?: () => Promise<OnboardingScanRuntime>
  readonly understanding?: OnboardingUnderstandingSeams
}

type Scan = Promise<Awaited<ReturnType<typeof runOnboardingScan>> | undefined>
/**
 * `omo.onboarding.scan` / `omo.onboarding.apply`: `omo setup`'s detection streamed to RPC clients
 * and its writers run on their consent. Programmatic only: no model is read or called, no socket is
 * opened, and nothing is written before an apply names its stages.
 */
export function createOnboardingScanComponent(deps: OnboardingScanComponentDependencies = {}): OmoSenpiComponent {
  return {
    name: "onboarding-scan",
    register(pi: SenpiExtensionAPI, _ctx: ComponentContext): void {
      const handle = pi.rpc?.handle
      if (handle === undefined) return
      const environment = deps.runtime ?? (() => ({}))
      const loadRuntime = deps.loadRuntime ?? loadOnboardingScanRuntime
      const scans = new Map<string, Scan>()
      let modelRegistry: ChildModelRegistry | undefined
      if (typeof pi.on === "function") {
        pi.on("session_start", (_payload, eventCtx) => {
          modelRegistry = resolveMemoryModelRegistry(eventCtx) ?? modelRegistry
        })
      }
      registerOnboardingUnderstanding(pi, handle, {
        environment,
        loadRun: async () => (await loadRuntime()).runOnboardingUnderstanding,
        modelRegistry: () => modelRegistry,
        scanSettled: async (scanId) => { await scans.get(scanId) },
        ...(deps.understanding === undefined ? {} : { seams: deps.understanding }),
      })

      handle(ONBOARDING_SCAN_RPC_METHOD, (request): OnboardingScanResponse => {
        const scanId = randomUUID()
        const includeCustomProviders = isRecord(request) && request["includeCustomProviders"] === true
        const emit = (event: unknown): void => pi.rpc?.emit(ONBOARDING_SCAN_RPC_EVENT, event)
        // The client learns the id from this response, so no event may precede it.
        const scan: Scan = new Promise((resolve) => setTimeout(resolve, 0))
          .then(loadRuntime)
          .then((runtime) => runtime.runOnboardingScan(environment(), { scanId, includeCustomProviders }, emit))
          .catch((error: unknown) => {
            emit({ scanId, kind: "done", source: "all", elapsedMs: 0, reason: error instanceof Error ? error.message : String(error) })
            return undefined
          })
        scans.set(scanId, scan)
        for (const id of [...scans.keys()].slice(0, Math.max(0, scans.size - RETAINED_SCANS))) scans.delete(id)
        return { scanId }
      })

      handle(ONBOARDING_APPLY_RPC_METHOD, async (request): Promise<OnboardingApplyResponse> => {
        const scanId = isRecord(request) ? request["scanId"] : undefined
        const stages = isRecord(request) ? request["stages"] : undefined
        if (typeof scanId !== "string" || !Array.isArray(stages)) return { kind: "invalid", reason: "apply needs a scanId and a stages list" }
        const unknown = stages.filter((stage) => !isApplyStage(stage))
        if (unknown.length > 0) return { kind: "invalid", reason: `unknown stages: ${unknown.map(String).join(", ")}` }
        const scan = scans.get(scanId)
        if (scan === undefined) return { kind: "unavailable", reason: "No scan with this id; it finished long ago or was already applied." }
        // One apply per scan: its plans describe the files as they were when the scan read them.
        scans.delete(scanId)
        const plans = await scan
        if (plans === undefined) return { kind: "unavailable", reason: "The scan failed before it planned anything." }
        const runtime = await loadRuntime()
        return { scanId, applied: await runtime.applyOnboardingScan(plans.plans, new Set(stages.filter(isApplyStage))) }
      })
    },
  }
}

function isApplyStage(value: unknown): value is OnboardingApplyStage {
  return ONBOARDING_APPLY_STAGES.some((stage) => stage === value)
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export async function loadOnboardingScanRuntime(): Promise<OnboardingScanRuntime> {
  const bundled = typeof OMO_SENPI_BUNDLED !== "undefined" && OMO_SENPI_BUNDLED
  const loaded: unknown = await import(new URL(bundled ? ONBOARDING_SCAN_RUNTIME_FILE : "scan-runtime.ts", import.meta.url).href)
  if (!isRecord(loaded)) throw new Error("onboarding scan runtime did not load")
  const run = loaded["runOnboardingScan"]
  const apply = loaded["applyOnboardingScan"]
  const facts = loaded["migrationFactsFromScan"]
  const understand = loaded["runOnboardingUnderstanding"]
  const context = loaded["onboardingScanContext"]
  if (typeof run !== "function" || typeof apply !== "function" || typeof facts !== "function" || typeof understand !== "function" || typeof context !== "function") {
    throw new Error("onboarding scan runtime is missing its scan, apply or understanding export")
  }
  return {
    runOnboardingScan: (...args) => Reflect.apply(run, undefined, args),
    applyOnboardingScan: (...args) => Reflect.apply(apply, undefined, args),
    migrationFactsFromScan: (...args) => Reflect.apply(facts, undefined, args),
    onboardingScanContext: (...args) => Reflect.apply(context, undefined, args),
    runOnboardingUnderstanding: (...args) => Reflect.apply(understand, undefined, args),
  }
}
