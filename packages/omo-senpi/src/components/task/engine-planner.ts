import type { OmoConfig, OmoTaskSettings } from "@oh-my-opencode/omo-config-core"
import type { AgentDefinition, ChildPlanner } from "@oh-my-opencode/senpi-task"

import type { SenpiExtensionAPI } from "../../extension/types"
import { createGenerationObservingPlanner, type CategoryConfigGenerations } from "./category-config-generation"
import { createCategoryUnavailableWarningPlanner } from "./category-unavailable-warning"
import { createTaskChildPlanner, type ResolveDefaultRoute, type ResolveModelRegistry } from "./planner"
import type { TaskRuntimeContext } from "./runtime-context"

export type EnginePlannerInput = {
  readonly pi: SenpiExtensionAPI
  readonly runtime: TaskRuntimeContext
  readonly agents: Readonly<Record<string, AgentDefinition>>
  readonly settings: OmoTaskSettings
  readonly readOmoConfig: () => OmoConfig
  readonly resolveRegistry: ResolveModelRegistry
  readonly resolveDefaultRoute: ResolveDefaultRoute
  readonly generations: CategoryConfigGenerations
}

/**
 * The engine's spawn planner. omo config is read once per plan, so a category chain edited in
 * omo.json reaches the next spawned child without restarting the session or its task host (#11355).
 */
export function createEnginePlanner(input: EnginePlannerInput): ChildPlanner {
  const { pi, runtime, agents, settings, readOmoConfig, resolveRegistry, resolveDefaultRoute, generations } = input
  const basePlanner: ChildPlanner = (spec) => {
    const omoConfig = readOmoConfig()
    return createGenerationObservingPlanner({
      planner: createTaskChildPlanner(omoConfig, agents, resolveRegistry, () => runtime.parentServiceTier(), resolveDefaultRoute),
      omoConfig,
      resolveRegistry,
      generations,
    })(spec)
  }
  return createCategoryUnavailableWarningPlanner({ planner: basePlanner, pi, runtime, readOmoConfig, settings })
}
