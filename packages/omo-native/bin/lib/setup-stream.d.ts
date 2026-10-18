// Types for setup-stream.js, which omo-senpi's onboarding scan imports across the package
// boundary: omo-ai ships this module as plain JS, so it is the single source of the setup stream.

export type SetupSource = "detect" | "providers" | "credentials" | "assets" | "model-choices"
export type SetupStageId = "credentials" | "assets" | "providers" | "model-choices"

export const SETUP_SOURCES: readonly SetupSource[]

export type SetupItem = {
  readonly id: string
  readonly kind: string
  readonly state: string
  readonly detail?: string
}

export type SetupStagePlan = {
  readonly pending: number
  readonly notices?: readonly string[]
  readonly [field: string]: unknown
}

export type SetupStageResult = {
  readonly source: SetupSource
  readonly items: readonly SetupItem[]
  readonly notices: readonly string[]
  readonly plan: SetupStagePlan
  readonly disabled?: true
  readonly error?: Error
}

export type SetupRuntime = {
  readonly home: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly pluginRoot?: string
  readonly loadModelCatalog?: () => Promise<readonly unknown[]>
  readonly loadSqlite?: () => Promise<unknown>
}

export type SetupScanOptions = {
  readonly includeCustomProviders?: boolean
  readonly onSourceStart?: (source: SetupSource) => void
}

export type SetupInventory = {
  readonly harnesses: readonly { readonly id: string; readonly installed: boolean }[]
}

export type SetupPlans = { readonly [stage: string]: unknown }

export type SetupApplyStage = {
  readonly id: SetupStageId
  readonly plan: SetupStagePlan
}

export function canonicalAgentDir(env?: Readonly<Record<string, string | undefined>>, home?: string): string

export function scanSetup(runtime: SetupRuntime, agentDir: string, options?: SetupScanOptions): AsyncGenerator<SetupStageResult, void, undefined>

export function collectSetupPlans(stream: AsyncIterable<SetupStageResult> | Iterable<SetupStageResult>): Promise<{ inventory: SetupInventory; plans: SetupPlans }>

export function applySetupStages(
  plans: SetupPlans,
  confirm: (stage: SetupApplyStage) => boolean | Promise<boolean>,
  report?: (line: string) => void,
): Promise<Set<SetupStageId>>
