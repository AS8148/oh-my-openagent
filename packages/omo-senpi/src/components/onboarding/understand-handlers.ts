import type { SenpiExtensionAPI } from "../../extension/types"
import type { OnboardingUnderstandRegistration } from "./understand-component"
import {
  ONBOARDING_UNDERSTAND_RPC_EVENT,
  type OnboardingUnderstandControlResponse,
  type OnboardingUnderstandEvent,
  type OnboardingUnderstandResponse,
} from "./understand-contract"
import type { OnboardingUnderstandingStarted, startOnboardingUnderstanding } from "./understand-start"

export interface OnboardingUnderstandHandlers {
  understand(request: unknown): Promise<OnboardingUnderstandResponse>
  skip(request: unknown): OnboardingUnderstandControlResponse
  stop(request: unknown): OnboardingUnderstandControlResponse
}

const MODEL_SELECTOR = /^[^/\s]+\/\S+$/

/** Ships in the onboarding-scan sidecar, so omo.js carries only the method registrations. */
export function createOnboardingUnderstandHandlers(pi: SenpiExtensionAPI, deps: OnboardingUnderstandRegistration): OnboardingUnderstandHandlers {
  const runs = new Map<string, OnboardingUnderstandingStarted["control"]>()
  const { busyScans } = deps

  const understand = async (request: unknown): Promise<OnboardingUnderstandResponse> => {
    if (!isRecord(request) || request["consent"] !== true) {
      return { kind: "invalid", reason: "Understanding sends the scan's session digests and each scanned project's AGENTS.md to the model provider, so it needs consent: true." }
    }
    const scanId = request["scanId"]
    const model = request["model"]
    if (typeof scanId !== "string" || scanId.length === 0) return { kind: "invalid", reason: "understand needs the scanId of a scan" }
    if (typeof model !== "string" || !MODEL_SELECTOR.test(model)) return { kind: "invalid", reason: "model must be provider/model" }
    const modelRegistry = deps.modelRegistry()
    if (modelRegistry === undefined) return { kind: "unavailable", reason: "No session has started yet, so no model is available." }
    if (busyScans.has(scanId)) return { kind: "invalid", reason: "An understanding run is already in progress for this scan; stop it or wait for its done event." }
    const token = Symbol(scanId)
    busyScans.set(scanId, token)
    const release = (): void => {
      if (busyScans.get(scanId) === token) busyScans.delete(scanId)
    }
    let started: Awaited<ReturnType<typeof startOnboardingUnderstanding>> | undefined
    try {
      const scan = await deps.scanForUnderstanding(scanId)
      if (scan === undefined) {
        return { kind: "unavailable", reason: "No retained scan with this id: it never ran, failed, expired after ten minutes, or was applied. Run omo.onboarding.scan again." }
      }
      const environment = deps.environment()
      let start: typeof startOnboardingUnderstanding
      try {
        start = await deps.loadStart()
      } catch (error) {
        return { kind: "unavailable", reason: `The onboarding runtime could not load: ${error instanceof Error ? error.message : String(error)}` }
      }
      const emit = (event: OnboardingUnderstandEvent): void => {
        if (event.kind === "done") release()
        pi.rpc?.emit(ONBOARDING_UNDERSTAND_RPC_EVENT, event)
      }
      started = await start({
        scanId,
        model,
        digests: scan.digests,
        projectRoots: scan.projectRoots,
        modelRegistry,
        ...(environment.env === undefined ? {} : { env: environment.env }),
        ...(deps.seams === undefined ? {} : { seams: deps.seams }),
      }, emit)
    } finally {
      if (started === undefined || "kind" in started) release()
    }
    if ("kind" in started) return started
    const { understandId, control: running, finished } = started
    runs.set(understandId, running)
    void finished.finally(() => {
      runs.delete(understandId)
      release()
    })
    return { understandId }
  }

  const control = (request: unknown, act: (run: OnboardingUnderstandingStarted["control"], body: Readonly<Record<string, unknown>>) => string | undefined): OnboardingUnderstandControlResponse => {
    const understandId = isRecord(request) ? request["understandId"] : undefined
    if (!isRecord(request) || typeof understandId !== "string") return { kind: "invalid", reason: "needs an understandId" }
    const run = runs.get(understandId)
    if (run === undefined) return { kind: "unavailable", reason: "No running understanding with this id." }
    const invalid = act(run, request)
    return invalid === undefined ? { understandId, accepted: true } : { kind: "invalid", reason: invalid }
  }

  return {
    understand,
    skip: (request) => control(request, (run, body) => {
      const project = body["project"]
      if (typeof project !== "string" || project.length === 0) return "skip needs a project directory"
      run.skip(project)
      return undefined
    }),
    stop: (request) => control(request, (run) => {
      run.stop()
      return undefined
    }),
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
