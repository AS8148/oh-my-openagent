import type { ModelCapabilitiesSnapshotEntry } from "./model-capabilities/types"

// LAUNCH-GATED: the ID is provisional. Fill only from the live launch listing, never from 5.1.
// Pricing is owned by the adopted senpi catalog; omo has no price override for this model.
export const FABLE_55_LAUNCH: ModelCapabilitiesSnapshotEntry = {
  id: "claude-fable-5-5",
  family: "claude-fable",
  reasoning: undefined,
  temperature: undefined,
  toolCall: undefined,
  modalities: undefined,
  limit: {
    context: undefined,
    input: undefined,
    output: undefined,
  },
}

// Flip to true only after the live listing confirms the id. Until then no routing path may pick it
// without availability proof (a cold provider-models cache gives none).
export const FABLE_55_RELEASED = false

export function isLaunchGatedModel(model: string): boolean {
  if (FABLE_55_RELEASED) return false
  const modelId = model.split("/").pop() ?? model
  return modelId.replaceAll(".", "-") === FABLE_55_LAUNCH.id
}

/** The model that stands in for Fable 5.5 until it is released (its launch-day predecessor). */
export const FABLE_55_PREDECESSOR = "claude-fable-5-1"

// Data-layer gate: every builtin chain, profile and default builds its 5.5 entries through these, so
// while FABLE_55_RELEASED is false no resolver (model-core, delegate-core, getFirstFallbackModel,
// senpi-task, cold/warm/null caches) can ever see the provisional id.
export function launchRungs<T extends { model: string }>(rungs: readonly T[]): T[] {
  return rungs.filter((rung) => !isLaunchGatedModel(rung.model))
}

export function launchDefaultModelId(): string {
  return FABLE_55_RELEASED ? FABLE_55_LAUNCH.id : FABLE_55_PREDECESSOR
}
