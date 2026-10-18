import { join } from "node:path"

import { existsSync, mkdir, rm } from "@oh-my-opencode/memory-core/fs"

import {
  FactsPlanParentDirtyError,
  GitMemoryRepo,
  LockContentionError,
  applyFactsRecovery,
  buildDefaultSeedFiles,
  createLockRecord,
  findFactsBatchReceipt,
  memoryWriterLockPath,
  planFactsMutation,
  validateFactsRecovery,
  withLock,
  type FactsApplyRecovery,
  type FactsExtractionRecord,
  type FactsPeopleRouting,
  type MemoryIdentity,
  type parseFactsExtractionJsonl,
} from "@oh-my-opencode/memory-core"
import type { OmoConfig } from "@oh-my-opencode/omo-config-core"

import type { ComponentLogger } from "../../extension/types"
import { ensureIdentityRuntimeDirs } from "./context"
import type { FactsRunLedger } from "./facts-runner-types"
import { updateRunLedger, writeRunJsonAtomic } from "./worker/run-artifacts"

const WRITER_ATTEMPTS = 3

export type Applied =
  | { readonly outcome: "committed"; readonly sha: string; readonly affectedPaths: readonly string[] }
  | { readonly outcome: "parent_dirty"; readonly detail?: string }

/** The cross-process `memory-write` lock every facts apply takes (2 s wait per attempt). */
export async function withFactsWriterLock<T>(locksDir: string, operation: () => Promise<T>, attempt: number, runId = `facts-${attempt}`): Promise<T> {
  const record = await createLockRecord("memory-write", { runId })
  return withLock(memoryWriterLockPath(locksDir), record, operation, { waitTimeoutMs: 2_000 })
}

/**
 * Applies records that did not come from a queued extractor run (a reviewed onboarding selection)
 * through the same `applyFactsWithRetries` path: same lock, same person routing, same batch receipt.
 * The batch keeps its recovery envelope in `<facts>/applied/<batchId>/` only while it applies.
 */
export async function applyFactsWithRetriesUnderLock(options: {
  readonly identity: MemoryIdentity
  readonly batchId: string
  readonly records: readonly FactsExtractionRecord[]
  readonly people: FactsPeopleRouting
  readonly logger?: ComponentLogger
  readonly now?: () => Date
}): Promise<Applied | undefined> {
  await ensureIdentityRuntimeDirs(options.identity.paths)
  const repo = new GitMemoryRepo({ dir: options.identity.paths.repo, agentId: options.identity.id })
  if (!existsSync(join(repo.dir, ".git"))) await repo.init({ seedFiles: buildDefaultSeedFiles() })
  const runDir = join(options.identity.paths.facts, "applied", options.batchId)
  await mkdir(runDir, { recursive: true, mode: 0o700 })
  const startedAt = (options.now ?? (() => new Date()))()
  const ledger: FactsRunLedger = {
    version: 1,
    runId: `apply-${options.batchId}`,
    kind: "facts",
    startedAt: startedAt.toISOString(),
    hardDeadlineAt: startedAt.getTime(),
    terminationGraceMs: 0,
    deadlineAt: startedAt.getTime(),
    batchId: options.batchId,
    queued: [],
  }
  try {
    await writeRunJsonAtomic(join(runDir, "ledger.json"), ledger)
    return await applyFactsWithRetries({
      runDir,
      ledger,
      repo,
      records: [...options.records],
      people: options.people,
      identity: options.identity,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      withWriterLock: (operation, attempt) => withFactsWriterLock(options.identity.paths.locks, operation, attempt, ledger.runId),
    })
  } finally {
    await rm(runDir, { recursive: true, force: true })
  }
}

export function resolveFactsPeopleRouting(config: OmoConfig, identity: string): FactsPeopleRouting {
  const memory = config.memory
  const override = memory?.agents[identity]?.people
  return {
    enabled: override?.enabled ?? memory?.people.enabled ?? true,
    maxEntries: override?.max_entries ?? memory?.people.max_entries ?? 40,
    maxEntryChars: override?.max_entry_chars ?? memory?.people.max_entry_chars ?? 200,
  }
}

export async function applyFactsWithRetries(options: {
  readonly runDir: string
  readonly ledger: FactsRunLedger
  readonly repo: GitMemoryRepo
  readonly records: ReturnType<typeof parseFactsExtractionJsonl>
  readonly people: FactsPeopleRouting
  readonly identity: MemoryIdentity
  readonly logger?: ComponentLogger
  readonly withWriterLock: <T>(operation: () => Promise<T>, attempt: number) => Promise<T>
  readonly retryDelay?: (attempt: number, delayMs: number) => Promise<void>
  readonly random?: () => number
}): Promise<Applied | undefined> {
  for (let attempt = 1; attempt <= WRITER_ATTEMPTS; attempt += 1) {
    try {
      return await options.withWriterLock(async () => applyClaimed(options), attempt)
    } catch (error) {
      if (!(error instanceof LockContentionError)) throw error
      if (attempt === WRITER_ATTEMPTS) {
        options.logger?.warn("facts extractor memory-write lock exhausted", { runId: options.ledger.runId })
        return undefined
      }
      const jitter = 25 + Math.floor((options.random ?? Math.random)() * 76)
      await (options.retryDelay ?? delay)(attempt, jitter)
    }
  }
  return undefined
}

async function applyClaimed(options: {
  readonly runDir: string
  readonly ledger: FactsRunLedger
  readonly repo: GitMemoryRepo
  readonly records: ReturnType<typeof parseFactsExtractionJsonl>
  readonly people: FactsPeopleRouting
  readonly identity: MemoryIdentity
  readonly logger?: ComponentLogger
}): Promise<Applied> {
  const receipt = await findFactsBatchReceipt(options.repo, options.ledger.batchId)
  if (receipt !== undefined) return { outcome: "committed", sha: receipt.sha, affectedPaths: receipt.paths ?? [] }
  const batch = { batchId: options.ledger.batchId, records: options.records }
  let recovery: FactsApplyRecovery
  if (options.ledger.applyRecovery !== undefined) {
    recovery = options.ledger.applyRecovery
    validateFactsRecovery(recovery, batch)
  } else {
    try {
      recovery = await planFactsMutation(options.repo, batch, options.people, (tie) => options.logger?.warn(
        "facts person alias tie resolved by slug order",
        { alias: tie.alias, slugs: tie.slugs.join(","), chosen: tie.chosen },
      ))
    } catch (error) {
      if (error instanceof FactsPlanParentDirtyError) return { outcome: "parent_dirty" }
      throw error
    }
    await updateRunLedger(`${options.runDir}/ledger.json`, {
      headBeforeApply: recovery.headBeforeApply,
      applyRecovery: recovery,
    })
  }
  const result = await applyFactsRecovery(options.repo, recovery, options.records.length, {
    agentId: options.identity.id,
    authorName: "Facts Extractor",
  })
  return result.outcome === "parent_dirty"
    ? result
    : { outcome: "committed", sha: result.sha, affectedPaths: result.affectedPaths }
}

function delay(_attempt: number, milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
