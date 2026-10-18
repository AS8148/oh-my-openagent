import { randomUUID } from "node:crypto"

import type { CreateChildSession, InProcessRunnerLike } from "@oh-my-opencode/senpi-task"

import type { ChildModelRegistry } from "../memory/model-registry-resolver"
import { createSessionDigestStore } from "./session-history"
import type { OnboardingUnderstandBudgetLimits, OnboardingUnderstandEvent } from "./understand-contract"
import { OnboardingUnderstandingControl } from "./understand-control"
import { runOnboardingUnderstanding } from "./understand-runtime"

export interface OnboardingUnderstandingSeams {
  readonly createRunner?: (options: { readonly createSession?: CreateChildSession }) => InProcessRunnerLike
  readonly createSession?: CreateChildSession
  readonly budget?: OnboardingUnderstandBudgetLimits
}

export interface OnboardingUnderstandingStart {
  readonly scanId: string
  readonly model: string
  readonly stateDir: string
  readonly modelRegistry: ChildModelRegistry
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly seams?: OnboardingUnderstandingSeams
}

export interface OnboardingUnderstandingStarted {
  readonly understandId: string
  readonly control: Pick<OnboardingUnderstandingControl, "skip" | "stop">
  readonly finished: Promise<void>
}

export type OnboardingUnderstandingStartResult =
  | OnboardingUnderstandingStarted
  | { readonly kind: "unavailable" | "invalid"; readonly reason: string }

/**
 * The understanding pass behind `omo.onboarding.understand`, shipped in the lazy onboarding-scan sidecar:
 * it reads the scan's digests, and when there are any, starts the run on the next macrotask so the caller
 * can answer with the id (and hold the control) before the first event.
 */
export async function startOnboardingUnderstanding(
  input: OnboardingUnderstandingStart,
  emit: (event: OnboardingUnderstandEvent) => void,
): Promise<OnboardingUnderstandingStartResult> {
  const digests = await createSessionDigestStore({ stateDir: input.stateDir }).list(input.scanId).catch(() => undefined)
  if (digests === undefined) return { kind: "invalid", reason: "scanId is not a valid scan id" }
  if (digests.length === 0) return { kind: "unavailable", reason: "This scan found no recent sessions to read." }

  const understandId = randomUUID()
  const control = new OnboardingUnderstandingControl()
  const { scanId, model, modelRegistry } = input
  const finished = new Promise((resolve) => setTimeout(resolve, 0))
    .then(() => runOnboardingUnderstanding({
      understandId,
      scanId,
      model,
      digests,
      modelRegistry,
      control,
      ...(input.env === undefined ? {} : { env: { ...input.env } }),
      ...input.seams,
    }, emit))
    .catch((error: unknown) => {
      emit({ understandId, scanId, kind: "done", bytesRead: 0, toolCalls: 0, elapsedMs: 0, candidates: [], fallback: "scan_only", reason: error instanceof Error ? error.message : String(error) })
    })
    .then(() => undefined)
  return { understandId, control, finished }
}
