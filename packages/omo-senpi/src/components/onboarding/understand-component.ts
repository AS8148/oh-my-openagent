import type { SenpiExtensionAPI } from "../../extension/types"
import type { ChildModelRegistry } from "../memory/model-registry-resolver"
import type { OnboardingScanEnvironment } from "./scan-runtime"
import type { SessionDigest } from "./session-history"
import {
  ONBOARDING_UNDERSTAND_RPC_METHOD,
  ONBOARDING_UNDERSTAND_SKIP_RPC_METHOD,
  ONBOARDING_UNDERSTAND_STOP_RPC_METHOD,
} from "./understand-contract"
import type { createOnboardingUnderstandHandlers, OnboardingUnderstandHandlers } from "./understand-handlers"
import type { OnboardingUnderstandingSeams, startOnboardingUnderstanding } from "./understand-start"

export type { OnboardingUnderstandingSeams } from "./understand-start"

/** What understanding may read from a retained scan: its in-memory digests and the project roots it listed. */
export interface OnboardingScanForUnderstanding {
  readonly digests: readonly SessionDigest[]
  readonly projectRoots: ReadonlySet<string>
}

export interface OnboardingUnderstandRegistration {
  readonly environment: () => OnboardingScanEnvironment
  readonly loadStart: () => Promise<typeof startOnboardingUnderstanding>
  readonly modelRegistry: () => ChildModelRegistry | undefined
  /** Shared by every session of the process: one understanding per scan at a time. */
  readonly busyScans: Map<string, symbol>
  /** The retained scan once it settles; undefined when it never ran, failed, expired, was evicted or applied. */
  readonly scanForUnderstanding: (scanId: string) => Promise<OnboardingScanForUnderstanding | undefined>
  readonly seams?: OnboardingUnderstandingSeams
}

/**
 * Registers `omo.onboarding.understand` / `.skip` / `.stop` synchronously; their bodies
 * (`understand-handlers.ts`) ship in the onboarding-scan sidecar and load on the first call.
 */
export function registerOnboardingUnderstanding(
  pi: SenpiExtensionAPI,
  handle: NonNullable<NonNullable<SenpiExtensionAPI["rpc"]>["handle"]>,
  deps: OnboardingUnderstandRegistration,
  loadHandlers: () => Promise<typeof createOnboardingUnderstandHandlers>,
): void {
  let handlers: Promise<OnboardingUnderstandHandlers> | undefined
  const loaded = async (): Promise<OnboardingUnderstandHandlers | { readonly kind: "unavailable"; readonly reason: string }> => {
    handlers ??= loadHandlers().then((create) => create(pi, deps))
    try {
      return await handlers
    } catch (error) {
      handlers = undefined
      return { kind: "unavailable", reason: `The onboarding runtime could not load: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  handle(ONBOARDING_UNDERSTAND_RPC_METHOD, async (request) => {
    const ready = await loaded()
    return "kind" in ready ? ready : ready.understand(request)
  })
  handle(ONBOARDING_UNDERSTAND_SKIP_RPC_METHOD, async (request) => {
    const ready = await loaded()
    return "kind" in ready ? ready : ready.skip(request)
  })
  handle(ONBOARDING_UNDERSTAND_STOP_RPC_METHOD, async (request) => {
    const ready = await loaded()
    return "kind" in ready ? ready : ready.stop(request)
  })
}
