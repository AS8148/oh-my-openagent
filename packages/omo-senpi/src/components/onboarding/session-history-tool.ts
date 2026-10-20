import { randomUUID } from "node:crypto"
import { join } from "node:path"

import type { AgentToolResult, ToolDefinition } from "@code-yeongyu/senpi"
import { type Static, Type } from "typebox"

import type {
  ProjectCandidate,
  ScanCounts,
  SessionDigest,
  SessionHistoryOptions,
  SessionHistoryScanEvent,
  SessionHistoryScanSource,
} from "./session-history"
import { loadSessionHistoryRuntime, type SessionHistoryRuntimeLoader } from "./session-history-runtime-loader"

export const ONBOARDING_SESSION_HISTORY_TOOL_NAME = "onboarding_session_history"

const DAY_MS = 24 * 60 * 60 * 1000
const SHOWN_PROJECTS = 40
const SHOWN_DIGESTS = 40

export const OnboardingSessionHistoryParams = Type.Object(
  {
    workspace_root: Type.Optional(Type.String({ minLength: 1 })),
    recent_days: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
  },
  { additionalProperties: false },
)
export type OnboardingSessionHistoryParams = Static<typeof OnboardingSessionHistoryParams>

export interface SourceSummary {
  readonly counts?: ScanCounts
  readonly error?: string
}

export interface OnboardingSessionHistoryDetails {
  readonly scanId: string
  readonly digestsFile: string
  readonly sources: Readonly<Partial<Record<SessionHistoryScanSource, SourceSummary>>>
  readonly projectCount: number
  readonly digestCount: number
}

export interface CreateOnboardingSessionHistoryToolOptions {
  /** Engine state dir; digests land in `<stateDir>/onboarding/scans/<scanId>/digests.jsonl`. */
  readonly stateDir: string
  /** Test seam: fixture homes, fs, clock. Production uses the module's defaults. */
  readonly scanOptions?: SessionHistoryOptions
  readonly newScanId?: () => string
  /** Test seam; production imports the scan runtime on the first call. */
  readonly loadRuntime?: SessionHistoryRuntimeLoader
}

/**
 * TUI consumer of the engine session-history module. It drives the same `scanSessionHistory` stream the
 * onboarding scan RPC (`omo.onboarding.scan`, #10478) exposes for the `projects` and `sessions` sources, so the
 * TUI and the desktop read one implementation. Read-only, no model call, no network.
 */
export function createOnboardingSessionHistoryTool(
  options: CreateOnboardingSessionHistoryToolOptions,
): ToolDefinition<typeof OnboardingSessionHistoryParams, OnboardingSessionHistoryDetails> {
  const newScanId = options.newScanId ?? (() => `tui-${randomUUID()}`)
  const loadRuntime = options.loadRuntime ?? loadSessionHistoryRuntime
  return {
    name: ONBOARDING_SESSION_HISTORY_TOOL_NAME,
    label: "Scan agent session history",
    description:
      "Onboarding: lists this machine's coding-agent projects and recent sessions (Claude Code and other agents' local history) " +
      "with a per-session digest: first request, tools used, files changed, outcome. Programmatic and read-only; " +
      "digests stay on this machine. Use it instead of reading transcript files by hand.",
    parameters: OnboardingSessionHistoryParams,
    exposure: "search",
    searchGroup: "onboarding",
    searchKeywords: ["onboarding", "session archaeology", "previous sessions", "agent history", "projects"],
    allowLazyActivation: true,
    executionMode: "sequential",
    async execute(_toolCallId, params): Promise<AgentToolResult<OnboardingSessionHistoryDetails>> {
      const { createSessionDigestStore, scanSessionHistory } = await loadRuntime()
      const scanId = newScanId()
      const digestStore = createSessionDigestStore({ stateDir: options.stateDir })
      const events = scanSessionHistory({
        ...options.scanOptions,
        scanId,
        digestStore,
        ...(params.workspace_root === undefined ? {} : { workspaceRoot: params.workspace_root }),
        ...(params.recent_days === undefined ? {} : { recentWindowMs: params.recent_days * DAY_MS }),
      })
      const { projects, sources } = await collectScan(events)
      const digests = await digestStore.list(scanId)
      const details: OnboardingSessionHistoryDetails = {
        scanId,
        digestsFile: join(options.stateDir, "onboarding", "scans", scanId, "digests.jsonl"),
        sources,
        projectCount: projects.length,
        digestCount: digests.length,
      }
      return { content: [{ type: "text", text: formatScan(details, projects, digests) }], details }
    },
  }
}

async function collectScan(events: AsyncIterable<SessionHistoryScanEvent>) {
  const projects: Array<ProjectCandidate> = []
  const sources: Partial<Record<SessionHistoryScanSource, SourceSummary>> = {}
  for await (const event of events) {
    if (event.kind === "item" && event.source === "projects" && event.item !== undefined && "path" in event.item) {
      projects.push(event.item)
    }
    if (event.kind === "source_done") sources[event.source] = event.counts === undefined ? {} : { counts: event.counts }
    if (event.kind === "source_failed") sources[event.source] = { error: event.error ?? "unknown error" }
  }
  return { projects, sources }
}

function formatSource(name: SessionHistoryScanSource, summary: SourceSummary | undefined): string {
  if (summary?.error !== undefined) return `${name}: failed (${summary.error})`
  const counts = summary?.counts
  return counts === undefined ? `${name}: no result` : `${name}: found ${counts.found}, read ${counts.read}, cap ${counts.cap}`
}

function formatScan(
  details: OnboardingSessionHistoryDetails,
  projects: ReadonlyArray<ProjectCandidate>,
  digests: ReadonlyArray<SessionDigest>,
): string {
  const lines = [
    `scan ${details.scanId}`,
    formatSource("projects", details.sources.projects),
    formatSource("sessions", details.sources.sessions),
    "",
    `projects (${projects.length}, newest first):`,
    ...projects.slice(0, SHOWN_PROJECTS).map((project) =>
      `- ${project.path} [${project.sources.join(",")}] threads=${project.threadCount} last=${project.lastActiveAt ?? "unknown"}`),
    ...(projects.length > SHOWN_PROJECTS ? [`- ... ${projects.length - SHOWN_PROJECTS} more`] : []),
    "",
    `session digests (${digests.length}; all in ${details.digestsFile}):`,
    ...digests.slice(0, SHOWN_DIGESTS).map((digest) => JSON.stringify(digest)),
  ]
  if (digests.length > SHOWN_DIGESTS) lines.push(`... ${digests.length - SHOWN_DIGESTS} more digests in the file above`)
  return lines.join("\n")
}
