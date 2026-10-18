import { homedir } from "node:os"

import {
  applySetupStages,
  canonicalAgentDir,
  collectSetupPlans,
  scanSetup,
  type SetupPlans,
  type SetupStageResult,
} from "../../../../omo-native/bin/lib/setup-stream.js"
import type { OnboardingApplyStage, OnboardingScanEvent, OnboardingScanSource } from "./scan-contract"

/** Where the scan reads and the apply writes; every field defaults to what `omo setup` uses. */
export interface OnboardingScanEnvironment {
  readonly home?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly agentDir?: string
}

/** One scan's outcome: the stage plans an apply needs, and the per-source rows a UI renders. */
export interface OnboardingScanOutcome {
  readonly plans: SetupPlans
  readonly results: readonly SetupStageResult[]
}

type EventBody = Omit<OnboardingScanEvent, "scanId" | "elapsedMs">

/**
 * Runs `omo setup`'s own stream and reports each source as `source_started`, its items, then
 * `source_done` (or `source_failed`), ending with one `done`. Resolves with the stage plans an
 * apply needs and the source rows a UI renders; a failed source has no plan, so its stage is
 * never applied.
 */
export async function runOnboardingScan(
  environment: OnboardingScanEnvironment,
  options: { readonly scanId: string; readonly includeCustomProviders: boolean },
  emit: (event: OnboardingScanEvent) => void,
): Promise<OnboardingScanOutcome> {
  const startedAt = performance.now()
  const send = (body: EventBody): void => emit({ scanId: options.scanId, ...body, elapsedMs: Math.round(performance.now() - startedAt) })
  const home = environment.home ?? homedir()
  const env = environment.env ?? process.env
  const agentDir = environment.agentDir ?? canonicalAgentDir(env, home)
  const results: SetupStageResult[] = []
  let found = 0
  const stream = scanSetup({ home, env }, agentDir, {
    includeCustomProviders: options.includeCustomProviders,
    onSourceStart: (source) => send({ kind: "source_started", source }),
  })
  for await (const result of stream) {
    results.push(result)
    if (result.disabled === true) continue
    const source: OnboardingScanSource = result.source
    if (result.error !== undefined) {
      send({ kind: "source_failed", source, reason: result.error.message })
      continue
    }
    for (const item of result.items) send({ kind: "item", source, item })
    found += result.items.length
    send({ kind: "source_done", source, counts: { found: result.items.length, read: result.items.length, cap: null } })
  }
  send({ kind: "done", source: "all", counts: { found, read: found, cap: null } })
  const plans = (await collectSetupPlans(results.filter((result) => result.error === undefined))).plans
  return { plans, results }
}

/** Applies the requested stages of a finished scan with the same writers `omo setup` uses. */
export async function applyOnboardingScan(plans: SetupPlans, stages: ReadonlySet<OnboardingApplyStage>): Promise<OnboardingApplyStage[]> {
  return [...await applySetupStages(plans, (stage) => stages.has(stage.id))]
}

const FACT_GROUPS: ReadonlyArray<readonly [string, ReadonlySet<string>]> = [
  ["sign-ins", new Set(["api-key", "oauth"])],
  ["providers", new Set(["provider"])],
  ["mcp", new Set(["mcp"])],
  ["skills", new Set(["skill"])],
  ["model choices", new Set(["default", "categories", "agents"])],
]

/**
 * The scan's rows as the one-line migration inventory the TUI onboarding injects: ids grouped by
 * category with each row's state, never a key. Undefined when the scan found nothing at all.
 */
export function migrationFactsFromScan(results: readonly SetupStageResult[]): string | undefined {
  const rows = results.flatMap((result) => (result.disabled === true ? [] : [...result.items]))
  if (rows.length === 0) return undefined
  return FACT_GROUPS
    .map(([label, kinds]) => [label, rows.filter((row) => kinds.has(row.kind))] as const)
    .filter(([, own]) => own.length > 0)
    .map(([label, own]) => `${label}: ${own.map((row) => `${row.id} (${row.state}${row.detail === undefined ? "" : ` - ${row.detail}`})`).join(", ")}`)
    .join("; ")
}
