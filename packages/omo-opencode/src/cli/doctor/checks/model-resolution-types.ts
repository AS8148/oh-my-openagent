import type { OhMyOpenCodeConfig } from "../../../config"
import type { ModelCapabilitiesDiagnostics } from "../../../shared/model-capabilities"
import type { ModelRequirement } from "../../../shared/model-requirements"

export interface AgentResolutionInfo {
  name: string
  requirement: ModelRequirement
  userOverride?: string
  userVariant?: string
  effectiveModel: string
  effectiveResolution: string
  capabilityDiagnostics?: ModelCapabilitiesDiagnostics
}

export interface CategoryResolutionInfo {
  name: string
  requirement: ModelRequirement
  userOverride?: string
  userVariant?: string
  effectiveModel: string
  effectiveResolution: string
  capabilityDiagnostics?: ModelCapabilitiesDiagnostics
}

export interface ModelResolutionInfo {
  agents: AgentResolutionInfo[]
  categories: CategoryResolutionInfo[]
}

/** The agents/categories view of the validated plugin config the runtime resolves from. */
export type OmoConfig = Pick<OhMyOpenCodeConfig, "agents" | "categories">

/** What the delegate-task runtime resolves for a user-configured category. */
export interface RuntimeCategoryResolution {
  model: string
  reasoning?: string
}

export interface AvailableModelsInfo {
  providers: string[]
  modelCount: number
  cacheExists: boolean
}
