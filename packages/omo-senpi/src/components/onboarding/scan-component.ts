import { randomUUID } from "node:crypto"

import type { ComponentContext, OmoSenpiComponent, SenpiExtensionAPI } from "../../extension/types"
import {
  ONBOARDING_APPLY_RPC_METHOD,
  ONBOARDING_APPLY_STAGES,
  ONBOARDING_SCAN_RPC_EVENT,
  ONBOARDING_SCAN_RPC_METHOD,
  type OnboardingApplyResponse,
  type OnboardingApplyStage,
  type OnboardingScanResponse,
} from "./scan-contract"
import type {
  applyOnboardingScan,
  authWritesPending,
  migrationFactsFromScan,
  OnboardingScanEnvironment,
  runOnboardingScan,
  staleSetupTargets,
} from "./scan-runtime"
import { resolve } from "node:path"

export * from "./scan-contract"

declare const OMO_SENPI_BUNDLED: boolean

/** The built runtime sits beside `omo.js`, so the entry bundle carries none of `omo setup`. */
export const ONBOARDING_SCAN_RUNTIME_FILE = "omo-onboarding-scan.js"
/** Finished scans an apply can still use; older ones answer `unavailable`. */
const RETAINED_SCANS = 8
/** A scan describes the machine only briefly; after this, an apply answers stale instead of writing. */
export const ONBOARDING_SCAN_TTL_MS = 10 * 60_000

export interface OnboardingScanRuntime {
  readonly runOnboardingScan: typeof runOnboardingScan
  readonly applyOnboardingScan: typeof applyOnboardingScan
  readonly migrationFactsFromScan: typeof migrationFactsFromScan
  readonly authWritesPending: typeof authWritesPending
  readonly staleSetupTargets: typeof staleSetupTargets
}

/** The engine's own credential store (senpi `AuthStorage`), narrowed to the surface an apply uses. */
export interface OnboardingEngineAuthStore {
  getStoragePath(): string
  modify(provider: string, fn: (current: unknown) => unknown | Promise<unknown>): Promise<unknown>
}

export interface OnboardingScanComponentDependencies {
  readonly runtime?: () => OnboardingScanEnvironment
  readonly loadRuntime?: () => Promise<OnboardingScanRuntime>
  /** The engine's credential store apply writes through; defaults to the one `session_start` reports. */
  readonly authStore?: () => OnboardingEngineAuthStore | undefined
  readonly now?: () => number
  /** Where finished scans wait for their apply; defaults to the one store every session of the process shares. */
  readonly scanStore?: OnboardingScanStore
}

type Scan = Promise<Awaited<ReturnType<typeof runOnboardingScan>> | undefined>
interface HeldScan {
  outcome: Scan
  finishedAt: number | undefined
}

/**
 * Retained scans and the last engine credential store, held for the whole engine process: a client
 * may scan on one control session and apply on the next, so nothing here may live per session.
 */
export interface OnboardingScanStore {
  readonly scans: Map<string, HeldScan>
  latestAuthStore: OnboardingEngineAuthStore | undefined
}

export function createOnboardingScanStore(): OnboardingScanStore {
  return { scans: new Map(), latestAuthStore: undefined }
}

const processScanStore = createOnboardingScanStore()
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
      const now = deps.now ?? (() => Date.now())
      const shared = deps.scanStore ?? processScanStore
      const scans = shared.scans
      // The engine's own AuthStorage (modelRegistry.authStorage): an apply's credential writes go
      // through its lock, so a token refresh that lands mid-apply is merged, never reverted. A
      // session that captured none (a fresh control session) uses the one the process captured last.
      let capturedStore: OnboardingEngineAuthStore | undefined
      const authStore = deps.authStore ?? (() => capturedStore ?? shared.latestAuthStore)
      pi.on("session_start", (_event, ctx) => {
        const registry = isRecord(ctx) && isRecord(ctx["modelRegistry"]) ? ctx["modelRegistry"] : undefined
        const candidate = isRecord(registry?.["authStorage"]) ? registry?.["authStorage"] : undefined
        if (
          candidate !== undefined && typeof candidate["getStoragePath"] === "function" && typeof candidate["modify"] === "function"
        ) {
          capturedStore = candidate as unknown as OnboardingEngineAuthStore
          shared.latestAuthStore = capturedStore
        }
      })

      handle(ONBOARDING_SCAN_RPC_METHOD, (request): OnboardingScanResponse => {
        const scanId = randomUUID()
        const includeCustomProviders = isRecord(request) && request["includeCustomProviders"] === true
        const held: HeldScan = { outcome: Promise.resolve(undefined), finishedAt: undefined }
        // The client learns the id from this response, so no event may precede it. The clock is
        // read when the final `done` event is emitted - inside the scan - so an apply racing in
        // right after the events never sees a stale-or-missing finish time.
        const emit = (event: unknown): void => {
          if (isRecord(event) && event["kind"] === "done") held.finishedAt = now()
          pi.rpc?.emit(ONBOARDING_SCAN_RPC_EVENT, event)
        }
        held.outcome = new Promise((resolve) => setTimeout(resolve, 0))
          .then(loadRuntime)
          .then((runtime) => runtime.runOnboardingScan(environment(), { scanId, includeCustomProviders }, emit))
          .catch((error: unknown) => {
            emit({ scanId, kind: "done", source: "all", elapsedMs: 0, reason: error instanceof Error ? error.message : String(error) })
            return undefined
          })
        scans.set(scanId, held)
        for (const [id, entry] of scans) {
          if (entry === held) continue
          if (entry.finishedAt !== undefined && now() - entry.finishedAt > ONBOARDING_SCAN_TTL_MS) scans.delete(id)
        }
        const retained = [...scans.keys()].filter((id) => {
          const entry = scans.get(id)
          return entry?.finishedAt !== undefined || id === scanId
        })
        for (const id of retained.slice(0, Math.max(0, retained.length - RETAINED_SCANS))) scans.delete(id)
        return { scanId }
      })

      handle(ONBOARDING_APPLY_RPC_METHOD, async (request): Promise<OnboardingApplyResponse> => {
        const scanId = isRecord(request) ? request["scanId"] : undefined
        const stages = isRecord(request) ? request["stages"] : undefined
        if (typeof scanId !== "string" || !Array.isArray(stages)) return { kind: "invalid", reason: "apply needs a scanId and a stages list" }
        const unknown = stages.filter((stage) => !isApplyStage(stage))
        if (unknown.length > 0) return { kind: "invalid", reason: `unknown stages: ${unknown.map(String).join(", ")}` }
        const held = scans.get(scanId)
        if (held === undefined) return { kind: "unavailable", reason: "No scan with this id; it finished long ago or was already applied." }
        // One apply per scan: its plans describe the files as they were when the scan read them.
        scans.delete(scanId)
        const plans = await held.outcome
        if (plans === undefined) return { kind: "unavailable", reason: "The scan failed before it planned anything." }
        if (held.finishedAt === undefined || now() - held.finishedAt > ONBOARDING_SCAN_TTL_MS) {
          return { kind: "stale", reason: "The scan expired; retained scans live ten minutes. Run omo.onboarding.scan again.", paths: [] }
        }
        const runtime = await loadRuntime()
        const requested = stages.filter(isApplyStage)
        // Staleness is answered before anything else: a target that changed since the scan means
        // the plans no longer describe the machine, so no store is consulted and nothing is written.
        const stale = runtime.staleSetupTargets(plans.plans, requested)
        if (stale.length > 0) {
          return { kind: "stale", reason: `targets changed since the scan: ${stale.join(", ")}`, paths: stale }
        }
        if (runtime.authWritesPending(plans.plans, requested)) {
          const store = authStore()
          if (store === undefined) {
            return { kind: "unavailable", reason: "The engine's credential store is not available, so credentials cannot be imported here; run omo setup --yes instead." }
          }
          const target = authTargetOf(plans.plans)
          if (target === undefined || resolve(store.getStoragePath()) !== resolve(target)) {
            return { kind: "unavailable", reason: `The engine's credential store (${store.getStoragePath()}) is not the planned target; run omo setup --yes instead.` }
          }
        }
        const notices: string[] = []
        const outcome = await runtime.applyOnboardingScan(plans.plans, new Set(requested), {
          ...(authStore() === undefined ? {} : {
            writeAuth: (target, additions) => writeAuthThrough(authStore() as OnboardingEngineAuthStore, target, additions),
          }),
          report: (line) => notices.push(line),
        })
        if ("kind" in outcome) {
          return outcome.applied === undefined
            ? { kind: "stale", reason: outcome.reason, paths: outcome.paths }
            : { kind: "stale", reason: outcome.reason, paths: outcome.paths, applied: outcome.applied }
        }
        return { scanId, applied: outcome.applied, ...(notices.length === 0 ? {} : { notices }) }
      })
    },
  }
}

function authTargetOf(plans: Record<string, unknown>): string | undefined {
  const credentials = isRecord(plans["credentials"]) ? plans["credentials"] : undefined
  if (isRecord(credentials) && typeof credentials["target"] === "string") return credentials["target"]
  const providers = isRecord(plans["providers"]) ? plans["providers"] : undefined
  const paths = isRecord(providers) && isRecord(providers["paths"]) ? providers["paths"] : undefined
  if (paths !== undefined && typeof paths["auth"] === "string") return paths["auth"]
  return undefined
}

async function writeAuthThrough(
  store: OnboardingEngineAuthStore,
  target: string,
  additions: readonly { readonly provider: string; readonly key: string }[],
): Promise<void> {
  if (resolve(store.getStoragePath()) !== resolve(target)) {
    throw new Error(`the engine's credential store is not the planned target ${target}`)
  }
  for (const item of additions) {
    // Under the store's lock: an entry the store already holds (a login or refresh that landed
    // after the scan) is kept exactly as it is.
    await store.modify(item.provider, (current: unknown) =>
      current === undefined ? { type: "api_key", key: item.key } : undefined)
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
  const authPending = loaded["authWritesPending"]
  const staleTargets = loaded["staleSetupTargets"]
  if (typeof run !== "function" || typeof apply !== "function" || typeof facts !== "function" || typeof authPending !== "function" || typeof staleTargets !== "function") {
    throw new Error("onboarding scan runtime is missing its scan or apply export")
  }
  return {
    runOnboardingScan: (...args) => Reflect.apply(run, undefined, args),
    applyOnboardingScan: (...args) => Reflect.apply(apply, undefined, args),
    migrationFactsFromScan: (...args) => Reflect.apply(facts, undefined, args),
    authWritesPending: (...args) => Reflect.apply(authPending, undefined, args),
    staleSetupTargets: (...args) => Reflect.apply(staleTargets, undefined, args),
  }
}
