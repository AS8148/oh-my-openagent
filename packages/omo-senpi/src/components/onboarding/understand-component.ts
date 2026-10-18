import { randomUUID } from "node:crypto"

import type { CreateChildSession, InProcessRunnerLike } from "@oh-my-opencode/senpi-task"

import type { SenpiExtensionAPI } from "../../extension/types"
import type { ChildModelRegistry } from "../memory/model-registry-resolver"
import { getOmoNativeStateDir } from "../telemetry/product-identity"
import type { OnboardingScanEnvironment } from "./scan-runtime"
import { createSessionDigestStore } from "./session-history"
import {
  ONBOARDING_UNDERSTAND_RPC_EVENT,
  ONBOARDING_UNDERSTAND_RPC_METHOD,
  ONBOARDING_UNDERSTAND_SKIP_RPC_METHOD,
  ONBOARDING_UNDERSTAND_STOP_RPC_METHOD,
  type OnboardingUnderstandBudgetLimits,
  type OnboardingUnderstandControlResponse,
  type OnboardingUnderstandEvent,
  type OnboardingUnderstandResponse,
} from "./understand-contract"
import { OnboardingUnderstandingControl } from "./understand-control"
import type { runOnboardingUnderstanding } from "./understand-runtime"

export interface OnboardingUnderstandingSeams {
  readonly createRunner?: (options: { readonly createSession?: CreateChildSession }) => InProcessRunnerLike
  readonly createSession?: CreateChildSession
  readonly budget?: OnboardingUnderstandBudgetLimits
}

export interface OnboardingUnderstandRegistration {
  readonly environment: () => OnboardingScanEnvironment
  readonly loadRun: () => Promise<typeof runOnboardingUnderstanding>
  readonly modelRegistry: () => ChildModelRegistry | undefined
  readonly scanSettled: (scanId: string) => Promise<void>
  readonly seams?: OnboardingUnderstandingSeams
}

const MODEL_SELECTOR = /^[^/\s]+\/\S+$/

export function registerOnboardingUnderstanding(pi: SenpiExtensionAPI, handle: NonNullable<NonNullable<SenpiExtensionAPI["rpc"]>["handle"]>, deps: OnboardingUnderstandRegistration): void {
  const runs = new Map<string, OnboardingUnderstandingControl>()

  handle(ONBOARDING_UNDERSTAND_RPC_METHOD, async (request): Promise<OnboardingUnderstandResponse> => {
    if (!isRecord(request) || request["consent"] !== true) {
      return { kind: "invalid", reason: "Understanding sends session digests to the model provider, so it needs consent: true." }
    }
    const scanId = request["scanId"]
    const model = request["model"]
    if (typeof scanId !== "string" || scanId.length === 0) return { kind: "invalid", reason: "understand needs the scanId of a scan" }
    if (typeof model !== "string" || !MODEL_SELECTOR.test(model)) return { kind: "invalid", reason: "model must be provider/model" }
    const modelRegistry = deps.modelRegistry()
    if (modelRegistry === undefined) return { kind: "unavailable", reason: "No session has started yet, so no model is available." }
    await deps.scanSettled(scanId)
    const environment = deps.environment()
    const stateDir = environment.stateDir ?? getOmoNativeStateDir(environment.env ?? process.env)
    const digests = await createSessionDigestStore({ stateDir }).list(scanId).catch(() => undefined)
    if (digests === undefined) return { kind: "invalid", reason: "scanId is not a valid scan id" }
    if (digests.length === 0) return { kind: "unavailable", reason: "This scan found no recent sessions to read." }

    const understandId = randomUUID()
    const control = new OnboardingUnderstandingControl()
    runs.set(understandId, control)
    const emit = (event: OnboardingUnderstandEvent): void => pi.rpc?.emit(ONBOARDING_UNDERSTAND_RPC_EVENT, event)
    // The client learns the id from this response, so no event may precede it.
    void new Promise((resolve) => setTimeout(resolve, 0))
      .then(deps.loadRun)
      .then((run) => run({
        understandId,
        scanId,
        model,
        digests,
        modelRegistry,
        control,
        ...(environment.env === undefined ? {} : { env: { ...environment.env } }),
        ...deps.seams,
      }, emit))
      .catch((error: unknown) => {
        emit({ understandId, scanId, kind: "done", bytesRead: 0, toolCalls: 0, elapsedMs: 0, candidates: [], fallback: "scan_only", reason: error instanceof Error ? error.message : String(error) })
      })
      .finally(() => runs.delete(understandId))
    return { understandId }
  })

  const control = (request: unknown, act: (run: OnboardingUnderstandingControl, body: Readonly<Record<string, unknown>>) => string | undefined): OnboardingUnderstandControlResponse => {
    const understandId = isRecord(request) ? request["understandId"] : undefined
    if (!isRecord(request) || typeof understandId !== "string") return { kind: "invalid", reason: "needs an understandId" }
    const run = runs.get(understandId)
    if (run === undefined) return { kind: "unavailable", reason: "No running understanding with this id." }
    const invalid = act(run, request)
    return invalid === undefined ? { understandId, accepted: true } : { kind: "invalid", reason: invalid }
  }
  handle(ONBOARDING_UNDERSTAND_SKIP_RPC_METHOD, (request) => control(request, (run, body) => {
    const project = body["project"]
    if (typeof project !== "string" || project.length === 0) return "skip needs a project directory"
    run.skip(project)
    return undefined
  }))
  handle(ONBOARDING_UNDERSTAND_STOP_RPC_METHOD, (request) => control(request, (run) => {
    run.stop()
    return undefined
  }))
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
