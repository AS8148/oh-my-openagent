import { isExcludedModel } from "@oh-my-opencode/omo-config-core"

import type { SenpiModelPort, SenpiModelRegistryPort } from "./category/types"
import type { ManagedRunner, ManagedStartSpec } from "./manager/types"
import { splitModelDecorators } from "./senpi/explicit-pin"

function modelKey(model: unknown): string | undefined {
  if (typeof model !== "object" || model === null) return undefined
  const provider: unknown = Reflect.get(model, "provider")
  const id: unknown = Reflect.get(model, "id")
  return typeof provider === "string" && typeof id === "string" ? `${provider}/${id}` : undefined
}

/**
 * The registry as `exclude_models` leaves it: an excluded model is neither available nor found, so
 * every chain walk (category, agent, builtin rung, memory child) skips it exactly as it skips a
 * model whose provider has no login. With no patterns the registry is returned unchanged.
 */
export function withoutExcludedModels<TModel extends SenpiModelPort>(
  registry: SenpiModelRegistryPort<TModel>,
  patterns: readonly string[] | undefined,
): SenpiModelRegistryPort<TModel> {
  if (patterns === undefined || patterns.length === 0) return registry
  return {
    getAvailable: () => {
      const available = registry.getAvailable()
      if (!Array.isArray(available)) return available
      return available.filter((model) => {
        const key = modelKey(model)
        return key === undefined || !isExcludedModel(key, patterns)
      })
    },
    find: (provider, modelId) => isExcludedModel(`${provider}/${modelId}`, patterns) ? undefined : registry.find(provider, modelId),
  }
}

/**
 * A runner whose children never carry an excluded model in their fallback chain. A record persisted
 * before the model was added to `exclude_models` still lists it, and respawn and resume rebuild the
 * child's chain from that record, so the chain is filtered at the runner every launch goes through.
 */
export function withoutExcludedFallbacks(runner: ManagedRunner, patterns: readonly string[] | undefined): ManagedRunner {
  if (patterns === undefined || patterns.length === 0) return runner
  const filter = (spec: ManagedStartSpec): ManagedStartSpec => spec.fallbackModels === undefined
    ? spec
    : { ...spec, fallbackModels: spec.fallbackModels.filter((model) => !isExcludedModel(`${model.provider}/${model.model_id}`, patterns)) }
  const resume = runner.resume
  return {
    start: (spec) => runner.start(filter(spec)),
    ...(resume === undefined ? {} : { resume: (spec: ManagedStartSpec, sessionPath: string) => resume.call(runner, filter(spec), sessionPath) }),
  }
}

/** The same filter over `provider/model[:level]` selectors, for a process child's rebuilt chain. */
export function withoutExcludedSelectors(selectors: readonly string[], patterns: readonly string[] | undefined): readonly string[] {
  if (patterns === undefined || patterns.length === 0) return selectors
  return selectors.filter((selector) => !isExcludedModel(splitModelDecorators(selector).base, patterns))
}
