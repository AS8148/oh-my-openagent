import { homedir } from "node:os"

import {
  applySetupStages,
  authWritesPending,
  canonicalAgentDir,
  collectSetupPlans,
  scanSetup,
  SetupStaleError,
  staleSetupTargets,
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

export { authWritesPending, staleSetupTargets } from "../../../../omo-native/bin/lib/setup-stream.js"

/** How an apply's credential additions and notice lines travel: through the engine's locked store, and to the caller's report sink. */
export interface ApplyOnboardingScanOptions {
  readonly writeAuth?: (target: string, additions: readonly { readonly provider: string; readonly key: string }[]) => Promise<void> | void
  readonly report?: (line: string) => void
}

export type OnboardingApplyOutcome =
  | { readonly applied: readonly OnboardingApplyStage[]; readonly notices: readonly string[] }
  | { readonly kind: "stale"; readonly reason: string; readonly paths: readonly string[]; readonly applied?: readonly OnboardingApplyStage[] }

/**
 * Applies the requested stages of a finished scan with the same writers `omo setup` uses. Every
 * requested stage's targets are re-read first and compared by content hash against what the scan
 * read: anything that changed since the scan answers `{kind: "stale"}` and nothing is written,
 * and a target that changes mid-apply refuses that stage instead of writing the scan-time copy.
 */
export async function applyOnboardingScan(
  plans: SetupPlans,
  stages: ReadonlySet<OnboardingApplyStage>,
  options: ApplyOnboardingScanOptions = {},
): Promise<OnboardingApplyOutcome> {
  const requested = [...stages]
  const stale = staleSetupTargets(plans, requested)
  if (stale.length > 0) {
    return { kind: "stale", reason: `targets changed since the scan: ${stale.join(", ")}`, paths: stale }
  }
  const notices: string[] = []
  const report = (line: string): void => {
    notices.push(line)
    options.report?.(line)
  }
  try {
    const applied = [...await applySetupStages(plans, (stage) => stages.has(stage.id), report, {
      ...(options.writeAuth === undefined ? {} : { writeAuth: options.writeAuth }),
      staleGuard: (stageId: string) => staleSetupTargets(plans, [stageId as OnboardingApplyStage]),
    })]
    return { applied, notices }
  } catch (error) {
    if (error instanceof SetupStaleError) {
      return {
        kind: "stale",
        reason: `targets changed since the scan: ${error.paths.join(", ")}`,
        paths: error.paths,
        ...(error.applied.length > 0 ? { applied: [...error.applied] as readonly OnboardingApplyStage[] } : {}),
      }
    }
    throw error
  }
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
