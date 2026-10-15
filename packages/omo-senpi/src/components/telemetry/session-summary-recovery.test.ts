import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { CHECKPOINT_MAX_TURNS } from "./omo-native-session-summary"
import { CORRUPT } from "./session-summary-files"
import { OWNER_STALE_MS, summaryDir } from "./session-summary-storage"
import { createTempStateDirs, createTestRecorder, rows, summaryTurn } from "./session-summary.test-support"

// Protocol contract (plan todo 8): a window is claimed only when its heartbeat is older than 5 minutes AND
// its owner is gone; a claimed window is published once as `recovered` under its own window id.

const stateDirs = createTempStateDirs()
afterEach(() => stateDirs.cleanup())

const T0 = 1_000_000
const STALE = OWNER_STALE_MS + 1

describe("session_summary recovery ownership", () => {
  test("#given a dead owner with a stale heartbeat #when two processes sweep #then the window is sent once as recovered with its window id", async () => {
    const dir = stateDirs.make()
    const dead = createTestRecorder({ dir, pid: 999_999, startAt: T0 })
    await dead.summary.recordTurn("dead", summaryTurn({ turnIndex: 0, totalTokens: 7 }))
    await dead.summary.recordTurn("dead", summaryTurn({ turnIndex: 1, totalTokens: 5 }))
    const windowId = readWindow(dead, "dead").windowId

    // Both sweepers are alive and see each other; only the window's owner is dead.
    const next = createTestRecorder({ dir, pid: 111_111, alivePids: [222_222], startAt: T0 + STALE })
    const racing = createTestRecorder({ dir, pid: 222_222, alivePids: [111_111], startAt: T0 + STALE })
    await Promise.all([next.summary.recover(), racing.summary.recover()])

    const recovered = [...next.published, ...racing.published]
    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.uuid).toBe(windowId)
    expect(recovered[0]?.properties).toMatchObject({ $session_id: "dead", summary_seq: 0, ended_by: "recovered", turns: 2, total_tokens: 12, is_final: false })
  })

  test("#given a dead owner whose heartbeat is still fresh #when a sweep runs #then nothing is claimed, and resuming the session continues the same window", async () => {
    const dir = stateDirs.make()
    const dead = createTestRecorder({ dir, pid: 999_998, startAt: T0 })
    await dead.summary.recordTurn("s1", summaryTurn({ turnIndex: 0 }))

    const resumed = createTestRecorder({ dir, pid: 111_112, startAt: T0 + OWNER_STALE_MS - 1 })
    await resumed.summary.recover()
    expect(resumed.published).toHaveLength(0)
    await resumed.summary.recordTurn("s1", summaryTurn({ turnIndex: 1 }))
    await resumed.summary.finish("s1", "quit")
    expect(rows(resumed.published)).toEqual([[0, "shutdown", 2]])
  })

  test("#given a live owner with a stale heartbeat (a sleeping laptop) #when another process sweeps #then the window is never claimed", async () => {
    const dir = stateDirs.make()
    const sleeper = createTestRecorder({ dir, pid: 333_333, startAt: T0 })
    await sleeper.summary.recordTurn("s1", summaryTurn())

    const other = createTestRecorder({ dir, pid: 444_444, otherPidsAlive: true, startAt: T0 + STALE * 10 })
    await other.summary.recover()
    expect(other.published).toHaveLength(0)
    expect(readWindow(sleeper, "s1").owner).toEqual(sleeper.storage.owner)
  })

  test("#given the owner's pid now belongs to a later OmO process #when a sweep runs #then the dead owner's window is recovered", async () => {
    const dir = stateDirs.make()
    const dead = createTestRecorder({ dir, pid: 555_555, bootId: "boot-old", startAt: T0 })
    await dead.summary.recordTurn("s1", summaryTurn())
    const reuser = createTestRecorder({ dir, pid: 555_555, bootId: "boot-new", startAt: T0 })
    await reuser.summary.recordTurn("other", summaryTurn())

    const sweeper = createTestRecorder({ dir, pid: 666_666, otherPidsAlive: true, startAt: T0 + STALE })
    await sweeper.summary.recover()
    expect(rows(sweeper.published)).toEqual([[0, "recovered", 1]])
  })

  test("#given a live owner whose heartbeat timer ticks #when another process sweeps 8 minutes later #then the window stays with its owner", async () => {
    const dir = stateDirs.make()
    const owner = createTestRecorder({ dir, pid: 777_777, startAt: T0 })
    await owner.summary.recordTurn("s1", summaryTurn())
    owner.advance(4 * 60_000)
    owner.tick()

    const sweeper = createTestRecorder({ dir, pid: 888_888, startAt: T0 + 8 * 60_000 })
    await sweeper.summary.recover()
    expect(sweeper.published).toHaveLength(0)
  })
})

describe("session_summary recovery hygiene", () => {
  test("#given a corrupt window file #when a sweep runs #then it is removed with a diagnostic and live sessions still report", async () => {
    const dir = stateDirs.make()
    const dead = createTestRecorder({ dir, pid: 999_997, startAt: T0 })
    await dead.summary.recordTurn("s1", summaryTurn())
    const file = join(summaryDir(dir), "s1.json")
    writeFileSync(file, "{not json")

    const next = createTestRecorder({ dir, pid: 121_212, startAt: T0 + STALE })
    await next.summary.recordTurn("s2", summaryTurn())
    await next.summary.finish("s2", "quit")

    expect(existsSync(file)).toBe(false)
    expect(next.diagnostics.map(({ event }) => event)).toContain("telemetry_activity_state_read_failed")
    expect(rows(next.published)).toEqual([[0, "shutdown", 1]])
  })

  test("#given temp and claim files left by dead processes #when a sweep runs #then temps are deleted and a dead claimer's window is handed back and recovered", async () => {
    const dir = stateDirs.make()
    const dead = createTestRecorder({ dir, pid: 999_991, startAt: T0 })
    await dead.summary.recordTurn("s1", summaryTurn())
    const base = summaryDir(dir)
    writeFileSync(join(base, "s9.json.999992-boot-999992.tmp"), "{}")
    renameSync(join(base, "s1.json"), join(base, "s1.json.claimed-999993-boot-999993"))

    const next = createTestRecorder({ dir, pid: 131_313, startAt: T0 + STALE })
    await next.summary.recover()

    expect(readdirSync(base).filter((name) => name.includes(".tmp") || name.includes(".claimed-"))).toEqual([])
    expect(rows(next.published)).toEqual([[0, "recovered", 1]])
  })

  test("#given a checkpoint #when the window is published #then its pending file and the advanced seq were already on disk", async () => {
    const dir = stateDirs.make()
    const probe = createTestRecorder({
      dir,
      startAt: T0,
      onPublish: (event, storage) => ({
        pending: storage.readPending(event.uuid) !== undefined,
        window: storage.readWindow(storage.windowKey("s1")),
      }),
    })
    for (let index = 0; index < CHECKPOINT_MAX_TURNS; index += 1) await probe.summary.recordTurn("s1", summaryTurn({ turnIndex: index }))

    expect(probe.observed).toEqual([{ pending: true, window: expect.objectContaining({ seq: 1, window: null, windowId: null }) }])
    expect(probe.storage.pendingUuids()).toEqual([])
  })
})

function readWindow(recorder: ReturnType<typeof createTestRecorder>, sessionHash: string) {
  const record = recorder.storage.readWindow(recorder.storage.windowKey(sessionHash))
  if (record === undefined || record === CORRUPT || record.windowId === null) throw new Error(`no open window for ${sessionHash}`)
  return { ...record, windowId: record.windowId }
}
