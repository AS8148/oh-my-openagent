import { randomUUID } from "node:crypto"

import type { AgentToolResult, ToolDefinition } from "@code-yeongyu/senpi"
import { type Static, Type } from "typebox"

import { sessionFactsApplier, type MemoryFactsApplyResponse } from "../memory/facts-apply-rpc"
import { resolveMemoryModelRegistry } from "../memory/model-registry-resolver"
import { createSessionDigestStore } from "./session-history"
import type { OnboardingUnderstandingSeams } from "./understand-component"
import type { OnboardingFactCandidate, OnboardingUnderstandEvent } from "./understand-contract"
import { OnboardingUnderstandingControl } from "./understand-control"
import type { runOnboardingUnderstanding } from "./understand-runtime"

export const ONBOARDING_UNDERSTAND_TOOL_NAME = "onboarding_understand"
export const ONBOARDING_MEMORY_APPLY_TOOL_NAME = "onboarding_memory_apply"

export interface TuiOnboardingScan {
  readonly scanId: string
  readonly stateDir: string
  readonly env?: Readonly<Record<string, string | undefined>>
}

export interface TuiMemoryToolsOptions {
  readonly scan: () => Promise<TuiOnboardingScan | undefined>
  readonly loadRun: () => Promise<typeof runOnboardingUnderstanding>
  readonly seams?: OnboardingUnderstandingSeams
}

export const OnboardingUnderstandParams = Type.Object(
  {
    consent: Type.Optional(Type.Boolean()),
    model: Type.Optional(Type.String({ minLength: 3 })),
  },
  { additionalProperties: false },
)
export const OnboardingMemoryApplyParams = Type.Object(
  {
    understand_id: Type.String({ minLength: 1 }),
    selected: Type.Array(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
)

export interface OnboardingUnderstandDetails {
  readonly understandId: string
  readonly candidates: readonly OnboardingFactCandidate[]
  readonly fallback?: "scan_only"
}

interface ToolCtx {
  readonly model?: { readonly provider?: unknown; readonly id?: unknown }
  readonly sessionManager?: { getSessionId(): string }
}

/**
 * TUI side of "understanding you": the same `runOnboardingUnderstanding` the `omo.onboarding.understand` RPC
 * runs, then the user's selection written through `omo.memory.facts.apply`'s applier. Candidates are held
 * in memory only; nothing reaches memory until a selection names them.
 */
export function createOnboardingMemoryTools(options: TuiMemoryToolsOptions): {
  readonly understand: ToolDefinition<typeof OnboardingUnderstandParams, OnboardingUnderstandDetails>
  readonly apply: ToolDefinition<typeof OnboardingMemoryApplyParams, MemoryFactsApplyResponse | undefined>
} {
  const runs = new Map<string, readonly OnboardingFactCandidate[]>()

  const understand: ToolDefinition<typeof OnboardingUnderstandParams, OnboardingUnderstandDetails> = {
    name: ONBOARDING_UNDERSTAND_TOOL_NAME,
    label: "Understand you from session history",
    description:
      "Onboarding: reads the onboarding scan's session digests with the model and proposes facts about the user and their projects. " +
      "Sends digests to the model provider, so call it only after the user agreed, with consent: true. Writes nothing; " +
      "show the candidates and let the user pick, then call onboarding_memory_apply with the picked ids.",
    parameters: OnboardingUnderstandParams,
    exposure: "search",
    searchGroup: "onboarding",
    searchKeywords: ["onboarding", "understanding", "memory candidates", "facts"],
    allowLazyActivation: true,
    executionMode: "sequential",
    async execute(_toolCallId, params: Static<typeof OnboardingUnderstandParams>, signal, _onUpdate, ectx): Promise<AgentToolResult<OnboardingUnderstandDetails>> {
      if (params.consent !== true) return failure("Ask the user first: understanding sends session digests to the model provider. Call again with consent: true once they agree.")
      const ctx = ectx as unknown as ToolCtx
      const model = params.model ?? currentModel(ctx)
      if (model === undefined) return failure("No model is selected in this session; pass model as provider/model.")
      const modelRegistry = resolveMemoryModelRegistry(ectx)
      if (modelRegistry === undefined) return failure("This session exposes no model registry, so the understanding cannot run.")
      const scan = await options.scan().catch(() => undefined)
      if (scan === undefined) return failure("The onboarding scan did not run; continue with the scan rows only.")
      const digests = await createSessionDigestStore({ stateDir: scan.stateDir }).list(scan.scanId)
      if (digests.length === 0) return failure("The scan found no recent sessions to read.")

      const understandId = randomUUID()
      const control = new OnboardingUnderstandingControl()
      const stop = (): void => control.stop()
      signal?.addEventListener("abort", stop, { once: true })
      const steps: string[] = []
      let done: OnboardingUnderstandEvent
      try {
        const run = await options.loadRun()
        done = await run({
          understandId,
          scanId: scan.scanId,
          model,
          digests,
          modelRegistry,
          control,
          ...(scan.env === undefined ? {} : { env: { ...scan.env } }),
          ...options.seams,
        }, (event) => {
          if (event.kind === "step_done" && event.step !== undefined) steps.push(event.step.label)
        })
      } finally {
        signal?.removeEventListener("abort", stop)
      }
      const candidates = done.candidates ?? []
      runs.set(understandId, candidates)
      const details: OnboardingUnderstandDetails = { understandId, candidates, ...(done.fallback === undefined ? {} : { fallback: done.fallback }) }
      return { content: [{ type: "text", text: formatCandidates(details, steps) }], details }
    },
  }

  const apply: ToolDefinition<typeof OnboardingMemoryApplyParams, MemoryFactsApplyResponse | undefined> = {
    name: ONBOARDING_MEMORY_APPLY_TOOL_NAME,
    label: "Remember the selected facts",
    description:
      "Onboarding: writes ONLY the candidate facts the user selected from onboarding_understand into memory, through the engine's " +
      "facts writer (one commit). Unselected candidates are never written. Pass the understand_id and the selected candidate ids.",
    parameters: OnboardingMemoryApplyParams,
    exposure: "search",
    searchGroup: "onboarding",
    searchKeywords: ["onboarding", "remember", "memory", "facts"],
    allowLazyActivation: true,
    executionMode: "sequential",
    async execute(_toolCallId, params: Static<typeof OnboardingMemoryApplyParams>, _signal, _onUpdate, ectx): Promise<AgentToolResult<MemoryFactsApplyResponse | undefined>> {
      const candidates = runs.get(params.understand_id)
      if (candidates === undefined) return failure("No open understanding with this id; its facts were already remembered or it never ran.")
      const unknown = params.selected.filter((id) => !candidates.some((candidate) => candidate.id === id))
      if (unknown.length > 0) return failure(`Not candidates of this understanding: ${unknown.join(", ")}. Nothing was written.`)
      const records = candidates.filter((candidate) => params.selected.includes(candidate.id)).map((candidate) => candidate.fact)
      if (records.length === 0) {
        const none: MemoryFactsApplyResponse = { outcome: "no_facts", affectedPaths: [] }
        return { content: [{ type: "text", text: "Nothing selected; nothing was written." }], details: none }
      }
      const applier = sessionFactsApplier()
      if (applier === undefined) return failure("Memory is off in this session, so nothing was written.")
      const sessionId = (ectx as unknown as ToolCtx).sessionManager?.getSessionId()
      const response = await applier({ records }, sessionId)
      if ("outcome" in response && response.outcome === "committed") runs.delete(params.understand_id)
      const text = "outcome" in response
        ? response.outcome === "committed"
          ? `Remembered ${records.length} ${records.length === 1 ? "fact" : "facts"} in one memory commit ${response.sha.slice(0, 12)}: ${response.affectedPaths.join(", ")}`
          : `Not written (${response.outcome}).`
        : `Not written: ${response.reason}`
      return { content: [{ type: "text", text }], details: response, ...("kind" in response ? { isError: true } : {}) }
    },
  }
  return { understand, apply }
}

function currentModel(ctx: ToolCtx): string | undefined {
  const provider = ctx.model?.provider
  const id = ctx.model?.id
  return typeof provider === "string" && typeof id === "string" ? `${provider}/${id}` : undefined
}

function formatCandidates(details: OnboardingUnderstandDetails, steps: readonly string[]): string {
  const lines = [
    `understanding ${details.understandId}`,
    ...steps.map((step) => `step: ${step}`),
    details.fallback === "scan_only"
      ? "The model could not read the sessions; continue from the scan rows only."
      : `${details.candidates.length} candidate ${details.candidates.length === 1 ? "fact" : "facts"} (nothing is saved yet):`,
    ...details.candidates.map((candidate) => {
      const who = candidate.fact.scope === "person" ? `about ${candidate.fact.person.name}` : "project"
      return `- [${candidate.id}] (${who}, from ${candidate.sources.length} sessions) ${candidate.fact.text}`
    }),
  ]
  return lines.join("\n")
}

function failure<T>(text: string): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details: undefined as T, isError: true }
}
