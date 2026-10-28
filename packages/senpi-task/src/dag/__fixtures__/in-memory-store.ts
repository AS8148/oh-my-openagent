// A DagFileStore that keeps the WAL, checkpoints, keys and results in process memory.
//
// Retry-semantics cases (#11621) assert the scheduler's behaviour, never crash durability, yet the
// file store charges every journal commit a run-lock create/unlink, a WAL append, several full WAL
// rescans and a temp+rename checkpoint. That cost is paid in contended host I/O, so a case's wall
// time scales with whatever else the machine is doing and a 12-commit case measured 31 ms idle and
// 414 ms under load. Durability is covered by store.test.ts and the e2e cases; here it only adds
// load-dependent wall time, so these cases run on memory instead.
//
// Semantics mirror the file store exactly where a test can observe them: seq must be strictly
// increasing, pages carry the same headSeq/hasMore/nextSinceSeq, and both checkpoints and events
// round-trip through JSON plus the paused encoding, so no caller can hold a live reference to
// stored state. Locks run their operation directly: the file lock's only in-process effect is
// mutual exclusion between synchronous sections, which single-threaded JS already provides.
import { join } from "node:path"

import { decodePausedNodes, decodePausedTransition, encodePausedNodes, encodePausedTransition } from "../paused-node-encoding"
import { dagKeyHash, type DagEventPage, type DagFileStore, type DagKeyRecord, type DagStorePaths } from "../store"
import type { DagRunEvent, DagRunId } from "../types"

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function memoryPaths(stateDir: string): DagStorePaths {
  const root = join(stateDir, "dag")
  const keys = join(root, "keys")
  const runs = join(root, "runs")
  const events = join(root, "events")
  const results = join(root, "results")
  const locks = join(root, "locks")
  return {
    root, keys, runs, events, results, locks,
    key: (parentSessionId, runKey) => join(keys, `${dagKeyHash(parentSessionId, runKey)}.json`),
    run: (runId) => join(runs, `${runId}.json`),
    event: (runId) => join(events, `${runId}.jsonl`),
    result: (runId, nodeId) => join(results, runId, `${nodeId}.txt`),
    runLock: (runId) => join(locks, `${runId}.lock`),
    keyLock: (parentSessionId, runKey) => join(locks, `key-${dagKeyHash(parentSessionId, runKey)}.lock`),
    taskOwnerLock: (taskOwner) => join(locks, `task-owner-${taskOwner}.lock`),
  }
}

export function createInMemoryDagStore(stateDir = "/memory/.omo/senpi-task"): DagFileStore {
  const paths = memoryPaths(stateDir)
  const eventsByRun = new Map<DagRunId, DagRunEvent[]>()
  const checkpoints = new Map<DagRunId, object>()
  const keys = new Map<string, DagKeyRecord>()
  const results = new Map<string, string>()
  return {
    stateDir,
    paths,
    diagnostics: () => [],
    appendEvent(event) {
      const log = eventsByRun.get(event.runId) ?? []
      const expectedSeq = (log.at(-1)?.seq ?? 0) + 1
      if (!Number.isSafeInteger(event.seq) || event.seq !== expectedSeq) {
        throw new Error(`DAG event seq must be strictly increasing: expected ${expectedSeq}, received ${event.seq}`)
      }
      log.push(clone(encodePausedTransition(event)))
      eventsByRun.set(event.runId, log)
    },
    readEvents(runId, sinceSeqExclusive, options): DagEventPage {
      if (!Number.isInteger(options.limit) || options.limit <= 0) {
        throw new Error("event page limit must be a positive integer")
      }
      const log = eventsByRun.get(runId) ?? []
      const wantedTypes = options.types === undefined ? undefined : new Set(options.types)
      const events: DagRunEvent[] = []
      let headSeq = 0
      let hasMore = false
      for (const stored of log) {
        const event = decodePausedTransition(clone(stored))
        headSeq = Math.max(headSeq, event.seq)
        if (event.seq <= sinceSeqExclusive) continue
        if (options.throughSeq !== undefined && event.seq > options.throughSeq) continue
        if (options.lane !== undefined && event.lane !== options.lane) continue
        if (wantedTypes !== undefined && !wantedTypes.has(event.type)) continue
        if (events.length < options.limit) events.push(event)
        else hasMore = true
      }
      return { events, nextSinceSeq: events.at(-1)?.seq ?? sinceSeqExclusive, headSeq, hasMore }
    },
    writeCheckpoint(runId, checkpoint) {
      checkpoints.set(runId, clone(encodePausedNodes(checkpoint)))
    },
    readCheckpoint<T extends object>(runId: DagRunId): T | null {
      const stored = checkpoints.get(runId)
      return stored === undefined ? null : decodePausedNodes(clone(stored) as T)
    },
    writeKey(record) {
      const path = paths.key(record.parentSessionId, record.runKey)
      keys.set(dagKeyHash(record.parentSessionId, record.runKey), clone(record))
      return path
    },
    readKey(parentSessionId, runKey) {
      const stored = keys.get(dagKeyHash(parentSessionId, runKey))
      return stored === undefined ? null : clone(stored)
    },
    writeResult(runId, nodeId, result) {
      results.set(`${runId}\u0000${nodeId}`, result)
      return paths.result(runId, nodeId)
    },
    readResult: (runId, nodeId) => results.get(`${runId}\u0000${nodeId}`) ?? null,
    withRunLock: (_runId, operation) => operation(),
    withKeyLock: (_parentSessionId, _runKey, operation) => operation(),
    withTaskOwnerLock: (_taskOwner, _runId, operation) => operation(),
    withSessionRunCapacity: (_parentSessionId, _runId, operation) => operation(),
    // Retention is a file-store concern (store.test.ts covers it); a memory store is discarded with its test.
    pruneExpired: () => [],
  }
}
