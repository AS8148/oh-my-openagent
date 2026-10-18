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
import type { OnboardingApplyStage, OnboardingScanEvent, OnboardingScanItem, OnboardingScanSource } from "./scan-contract"
import {
  createMemorySessionDigestStore,
  MAX_TRANSCRIPTS_PER_SOURCE,
  scanSessionHistory,
  type ProjectCandidate,
  type SessionDigest,
  type SessionHistoryOptions,
  type SessionScanItem,
} from "./session-history"

export { startOnboardingUnderstanding } from "./understand-start"

/** Where the scan reads and the apply writes; every field defaults to what `omo setup` uses. */
export interface OnboardingScanEnvironment {
  readonly home?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly agentDir?: string
  /** Session-history overrides (agent homes, omo session roots, clock); defaults read this machine. */
  readonly sessionHistory?: SessionHistoryOptions
}

/**
 * One scan's outcome: the stage plans an apply needs, the per-source rows a UI renders, and what
 * understanding may read after consent. The digests live only in memory, with the retained scan.
 */
export interface OnboardingScanOutcome {
  readonly plans: SetupPlans
  readonly results: readonly SetupStageResult[]
  readonly digests: readonly SessionDigest[]
  /** The project roots the scan showed the user; understanding reads AGENTS.md only inside these. */
  readonly projectRoots: ReadonlySet<string>
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
  let read = found
  // Nothing is persisted before consent: the digests stay in memory, with the retained scan.
  const digestStore = createMemorySessionDigestStore()
  const projectRoots = new Set<string>()
  const history = scanSessionHistory({
    homeDir: home,
    env,
    ...environment.sessionHistory,
    scanId: options.scanId,
    digestStore,
  })
  for await (const event of history) {
    const source = event.source
    if (event.kind === "source_started") send({ kind: "source_started", source })
    else if (event.kind === "source_failed") send({ kind: "source_failed", source, reason: event.error ?? "unknown error" })
    else if (event.kind === "item" && event.item !== undefined) {
      if ("path" in event.item) projectRoots.add(event.item.path)
      send({ kind: "item", source, item: historyItem(event.item) })
    }
    else if (event.kind === "source_done" && event.counts !== undefined) {
      found += event.counts.found
      read += event.counts.read
      send({ kind: "source_done", source, counts: { found: event.counts.found, read: event.counts.read, cap: MAX_TRANSCRIPTS_PER_SOURCE } })
    }
  }
  send({ kind: "done", source: "all", counts: { found, read, cap: null } })
  const plans = (await collectSetupPlans(results.filter((result) => result.error === undefined))).plans
  return { plans, results, digests: await digestStore.list(options.scanId), projectRoots }
}

function historyItem(item: ProjectCandidate | SessionScanItem): OnboardingScanItem {
  if ("path" in item) return { id: item.path, kind: "project", state: item.alreadyImported ? "imported" : "found", detail: item.title }
  return { id: item.sessionKey, kind: "session", state: "found", detail: item.title, project: item.cwd }
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
