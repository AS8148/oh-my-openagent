import type { SenpiExtensionAPI } from "../../extension/types"
import { readOnboardingCompletedAt } from "./state"

export const ONBOARDING_STATE_GET_RPC_METHOD = "omo.onboarding.state.get"
export const ONBOARDING_STATE_COMPLETE_RPC_METHOD = "omo.onboarding.state.complete"
export const ONBOARDING_STATE_RESET_RPC_METHOD = "omo.onboarding.state.reset"

/** The one install-wide completion flag (`onboarding/state.ts`) the TUI and RPC clients share. */
export interface OnboardingStateResponse {
  readonly completed: boolean
  /** ISO time the flag was set; null when onboarding is not complete. */
  readonly completedAt: string | null
}

export interface OnboardingStateStore {
  readonly stateDir: string
  claimOnboarding(stateDir: string): boolean
  releaseOnboarding(stateDir: string): void
}

export function registerOnboardingStateRpc(pi: SenpiExtensionAPI, store: OnboardingStateStore): void {
  const handle = pi.rpc?.handle
  if (handle === undefined) return
  const read = (): OnboardingStateResponse => {
    const completedAt = readOnboardingCompletedAt(store.stateDir)
    return { completed: completedAt !== null, completedAt }
  }
  handle(ONBOARDING_STATE_GET_RPC_METHOD, read)
  handle(ONBOARDING_STATE_COMPLETE_RPC_METHOD, () => {
    store.claimOnboarding(store.stateDir)
    return read()
  })
  handle(ONBOARDING_STATE_RESET_RPC_METHOD, () => {
    store.releaseOnboarding(store.stateDir)
    return read()
  })
}
