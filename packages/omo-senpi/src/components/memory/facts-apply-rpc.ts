import { randomUUID } from "node:crypto"

import {
  MemorySecretError,
  parseFactsExtractionRecord,
  type FactsExtractionRecord,
  type FactsPeopleRouting,
} from "@oh-my-opencode/memory-core"

import type { ComponentLogger } from "../../extension/types"
import type { MemoryIdentityContext } from "./context"
import { applyFactsWithRetriesUnderLock, resolveFactsPeopleRouting, type Applied } from "./facts-batch-apply"
import type { MemoryWiringOptions } from "./wiring-types"

/** Pull channel: an RPC client writes reviewed facts through the facts extractor's own apply. */
export const MEMORY_FACTS_APPLY_RPC_METHOD = "omo.memory.facts.apply"

export interface MemoryFactsApplyRequest {
  /** memory-core `record_fact` records; each is validated by `parseFactsExtractionRecord`. */
  readonly records: readonly unknown[]
}

export type MemoryFactsApplyResponse =
  | { readonly outcome: "committed"; readonly sha: string; readonly affectedPaths: readonly string[]; readonly batchId: string }
  | { readonly outcome: "no_facts"; readonly affectedPaths: readonly [] }
  | { readonly outcome: "parent_dirty"; readonly batchId: string; readonly detail?: string }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "invalid"; readonly reason: string }

export type MemoryFactsApplier = (request: unknown, sessionId?: string) => Promise<MemoryFactsApplyResponse>

export interface FactsApplyCall {
  readonly batchId: string
  readonly records: readonly FactsExtractionRecord[]
  readonly people: FactsPeopleRouting
}

/** Validates the request, then hands the batch to the extractor's apply; unselected records never arrive here. */
export async function applyMemoryFacts(input: {
  readonly context: MemoryIdentityContext
  readonly people: FactsPeopleRouting
  readonly request: unknown
  readonly logger?: ComponentLogger
  readonly newBatchId?: () => string
  readonly apply?: (call: FactsApplyCall) => Promise<Applied | undefined>
}): Promise<MemoryFactsApplyResponse> {
  const raw = isRecord(input.request) ? input.request["records"] : undefined
  if (!Array.isArray(raw)) return { kind: "invalid", reason: "facts apply needs a records list" }
  const records: FactsExtractionRecord[] = []
  for (const [index, value] of raw.entries()) {
    try {
      records.push(parseFactsExtractionRecord(value, index))
    } catch (error) {
      return { kind: "invalid", reason: `record ${index + 1} rejected: ${describe(error)}` }
    }
  }
  if (records.length === 0) return { outcome: "no_facts", affectedPaths: [] }
  const batchId = (input.newBatchId ?? randomUUID)()
  const context = input.context
  const apply = input.apply ?? ((call: FactsApplyCall) => applyFactsWithRetriesUnderLock({
    identity: { id: context.identity, safeSlug: context.identity, paths: context.identityPaths },
    ...call,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  }))
  let applied: Applied | undefined
  try {
    applied = await apply({ batchId, records, people: input.people })
  } catch (error) {
    if (error instanceof MemorySecretError) return { kind: "invalid", reason: error.message }
    throw error
  }
  if (applied === undefined) return { kind: "unavailable", reason: "The memory-write lock stayed busy; try again." }
  if (applied.outcome === "parent_dirty") {
    return { outcome: "parent_dirty", batchId, ...(applied.detail === undefined ? {} : { detail: applied.detail }) }
  }
  return { outcome: "committed", sha: applied.sha, affectedPaths: applied.affectedPaths, batchId }
}

/** The applier the memory component owns: the session's bound identity and its configured people routing. */
export function createSessionFactsApplier(deps: {
  readonly resolveContext: (sessionId: string | undefined) => MemoryIdentityContext | undefined
  readonly people: (identity: string) => FactsPeopleRouting
  readonly logger?: ComponentLogger
}): MemoryFactsApplier {
  return async (request, sessionId) => {
    const context = deps.resolveContext(sessionId)
    if (context === undefined) return { kind: "unavailable", reason: "No bound memory session." }
    return applyMemoryFacts({
      context,
      people: deps.people(context.identity),
      request,
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    })
  }
}

/** The session applier with people routing read from the current omo config on every call. */
export function createConfiguredFactsApplier(
  options: Pick<MemoryWiringOptions, "loadConfig" | "cwd" | "logger">,
  resolveContext: (sessionId: string | undefined) => MemoryIdentityContext | undefined,
): MemoryFactsApplier {
  return createSessionFactsApplier({
    resolveContext,
    people: (identity) => resolveFactsPeopleRouting(options.loadConfig({ cwd: options.cwd() }).config, identity),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })
}

// The onboarding component is registered before memory and cannot import its wiring, so the memory
// component publishes its one applier here, process-wide, like `sharedSessionArming`.
const APPLIER_KEY = Symbol.for("omo.memory.facts.applier")
const slot = globalThis as { [APPLIER_KEY]?: MemoryFactsApplier }

export function publishSessionFactsApplier(applier: MemoryFactsApplier | undefined): void {
  if (applier === undefined) Reflect.deleteProperty(slot, APPLIER_KEY)
  else slot[APPLIER_KEY] = applier
}

export function sessionFactsApplier(): MemoryFactsApplier | undefined {
  return slot[APPLIER_KEY]
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
