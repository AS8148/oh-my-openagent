import { homedir } from "node:os"

import type { OmoConfig, OmoTaskSettings } from "@oh-my-opencode/omo-config-core"
import { resolveTaskAgents, type ChildPlanner, type PlanConfigError, type PlanResolution } from "@oh-my-opencode/senpi-task"

import type { SenpiExtensionAPI } from "../../extension/types"
import type { SenpiConfigDiagnostic } from "../config-resolution"
import { createGenerationObservingPlanner, type CategoryConfigGenerations } from "./category-config-generation"
import { createCategoryUnavailableWarner } from "./category-unavailable-warning"
import { createTaskChildPlanner, type ResolveDefaultRoute, type ResolveModelRegistry } from "./planner"
import type { TaskRuntimeContext } from "./runtime-context"

/** One read of the effective omo config: the merged config and what the loader found wrong with each layer. */
export type SpawnOmoConfig = {
  readonly config: OmoConfig
  readonly diagnostics: readonly SenpiConfigDiagnostic[]
}

export type EnginePlannerInput = {
  readonly pi: SenpiExtensionAPI
  readonly runtime: TaskRuntimeContext
  readonly settings: OmoTaskSettings
  readonly loadOmoConfig: () => SpawnOmoConfig
  readonly resolveRegistry: ResolveModelRegistry
  readonly resolveDefaultRoute: ResolveDefaultRoute
  readonly generations: CategoryConfigGenerations
}

// A model catalog cycle leaves model references unresolvable, so it blocks routing like an invalid value.
const BLOCKING_KINDS: ReadonlySet<string> = new Set(["parse", "read", "validation", "model_catalog_cycle"])

function displayPath(path: string, home = homedir()): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

function configError(diagnostic: SenpiConfigDiagnostic): PlanConfigError {
  const position = "position" in diagnostic ? diagnostic.position : undefined
  return {
    kind: diagnostic.kind === "parse" || diagnostic.kind === "read" ? diagnostic.kind : "validation",
    path: displayPath(diagnostic.path),
    ...(position === undefined ? {} : { position }),
    ...(diagnostic.issuePaths === undefined ? {} : { issue_paths: diagnostic.issuePaths }),
  }
}

function configErrorMessage(error: PlanConfigError): string {
  const where = error.position !== undefined
    ? `${error.path}:${error.position.line}:${error.position.column}`
    : error.issue_paths !== undefined && error.issue_paths.length > 0
      ? `${error.path} at ${error.issue_paths.join(", ")}`
      : error.path
  const what = error.kind === "parse" ? "is not valid JSON" : error.kind === "read" ? "could not be read" : "has an invalid value"
  return `omo config ${where} ${what}. No task was started; fix the file and spawn again (the task never runs on another config).`
}

/**
 * The engine's spawn planner. omo config is read once per plan, so a category chain or an agent edited in
 * omo.json reaches the next spawned child without restarting the session or its task host (#11355). A layer
 * that exists but cannot be parsed, read or validated fails the spawn with a typed `config_invalid` error
 * naming the file and position: routing never falls back to another layer, the defaults or the session's
 * startup config. That one read also feeds the dead-chain warning, so a spawn costs exactly one config load.
 */
export function createEnginePlanner(input: EnginePlannerInput): ChildPlanner {
  const { pi, runtime, settings, loadOmoConfig, resolveRegistry, resolveDefaultRoute, generations } = input
  const warn = createCategoryUnavailableWarner({ pi, runtime, settings })
  return (spec): PlanResolution => {
    const loaded = loadOmoConfig()
    const blocking = loaded.diagnostics.find((diagnostic) => BLOCKING_KINDS.has(diagnostic.kind))
    if (blocking !== undefined) {
      const error = configError(blocking)
      return { kind: "error", error: { code: "config_invalid", message: configErrorMessage(error), config_error: error } }
    }
    const omoConfig = loaded.config
    const resolution = createGenerationObservingPlanner({
      planner: createTaskChildPlanner(omoConfig, resolveTaskAgents(omoConfig), resolveRegistry, () => runtime.parentServiceTier(), resolveDefaultRoute),
      omoConfig,
      resolveRegistry,
      generations,
    })(spec)
    warn(resolution, omoConfig)
    return resolution
  }
}
