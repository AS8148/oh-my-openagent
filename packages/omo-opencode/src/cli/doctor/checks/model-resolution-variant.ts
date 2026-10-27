import { resolveAgentVariant } from "../../../shared/agent-variant"
import type { ModelRequirement } from "../../../shared/model-requirements"
import type { OmoConfig } from "./model-resolution-types"

export function formatModelWithVariant(model: string, variant?: string): string {
  return variant ? `${model} (${variant})` : model
}

function builtinVariant(requirement: ModelRequirement): string | undefined {
  const firstEntry = requirement.fallbackChain[0]
  return firstEntry?.variant ?? requirement.variant
}

/** The runtime's own agent reasoning precedence (resolveAgentVariant), then the builtin chain. */
export function getEffectiveVariant(
  agentName: string,
  requirement: ModelRequirement,
  config: OmoConfig
): string | undefined {
  return resolveAgentVariant(config, agentName) ?? builtinVariant(requirement)
}

export function getCategoryEffectiveVariant(
  categoryName: string,
  requirement: ModelRequirement,
  config: OmoConfig
): string | undefined {
  const category = config.categories?.[categoryName]
  return category?.reasoning ?? category?.variant ?? builtinVariant(requirement)
}
