import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, renameSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { createOwnerLiveness } from "./session-summary-liveness"
import { createOwnerRegistry, currentProcessOwner } from "./session-summary-owner"
import { withRecoveryOps } from "./session-summary-recovery-storage"
import { OWNER_STALE_MS, createSummaryStorage, summaryDir } from "./session-summary-storage"
import { createTempStateDirs, createTestRecorder, summaryTurn } from "./session-summary.test-support"

// An owner is alive only while its pid is alive, the registry names its boot id, AND the pid still names the
// process that wrote the entry (same start time). A SIGKILLed owner never removes its entry, so without the
// start time any process that later reuses the pid would keep the dead owner's files on disk.

const stateDirs = createTempStateDirs()
afterEach(() => stateDirs.cleanup())

const T0 = 1_000_000
const STALE = OWNER_STALE_MS + 1

const ownerEntry = (dir: string, pid: number) => join(summaryDir(dir), "owners", `${pid}.json`)

describe("owner registry pid reuse", () => {
  test("#given a killed owner whose pid now names a process started at another time #when a sweep runs #then its window, pending event and claim are recovered and its entry is removed", async () => {
    const dir = stateDirs.make()
    const killed = createTestRecorder({ dir, pid: 515_151, startAt: T0, ack: false, startTimes: () => "started-before-the-kill" })
    await killed.summary.recordTurn("pending", summaryTurn())
    await killed.summary.finish("pending", "quit")
    await killed.summary.recordTurn("open", summaryTurn())
    await killed.summary.recordTurn("claimed", summaryTurn())
    const base = summaryDir(dir)
    renameSync(join(base, "claimed.json"), join(base, "claimed.json.claimed-515151-boot-515151"))
    expect(killed.storage.pendingUuids()).toHaveLength(1)

    // when: pid 515151 is alive again, but as an unrelated process started later
    const sweeper = createTestRecorder({ dir, pid: 616_161, otherPidsAlive: true, startAt: T0 + STALE, startTimes: () => "started-after-the-kill" })
    await sweeper.summary.recover()

    // then
    expect(sweeper.published.map(({ properties }) => [properties.$session_id, properties.ended_by]).sort()).toEqual([
      ["claimed", "recovered"],
      ["open", "recovered"],
      ["pending", "shutdown"],
    ])
    expect(readdirSync(base).filter((name) => name.includes(".claimed-"))).toEqual([])
    expect(sweeper.storage.pendingUuids()).toEqual([])
    expect(existsSync(ownerEntry(dir, 515_151))).toBe(false)
  })

  test("#given an entry written by this test process for owner pid 1 #when the real probes read it #then pid 1 is another process, so the owner is dead and its entry is removed", () => {
    const dir = stateDirs.make()
    const killed = { pid: 1, bootId: "killed" }
    createSummaryStorage({ stateDir: dir, owner: killed, isPidAlive: () => false }).writeWindow("k", {
      consent: "enabled", scope: { cwd: "/p" }, sessionHash: "k", sessionRole: "root", owner: killed, heartbeatAt: Date.now(),
      epoch: "0123456789abcdef", seq: 0, sampleRate: 0, windowId: null, window: null,
    })
    expect(existsSync(ownerEntry(dir, 1))).toBe(true)

    // when
    const reader = withRecoveryOps(createSummaryStorage({ stateDir: dir, owner: currentProcessOwner() }))

    // then
    expect(reader.isOwnerAlive(killed)).toBe(false)
    expect(existsSync(ownerEntry(dir, 1))).toBe(false)
  })

  test("#given an entry this process wrote under another boot id slot #when the real probes read it #then the same process is still alive", () => {
    const dir = stateDirs.make()
    const owner = { pid: process.pid, bootId: "same-process-other-module" }
    createOwnerRegistry({ dir: summaryDir(dir), owner }).register()

    // when
    const reader = withRecoveryOps(createSummaryStorage({ stateDir: dir, owner: { pid: 2_147_483_000, bootId: "reader" } }))

    // then
    expect(reader.isOwnerAlive(owner)).toBe(true)
  })
})

describe("owner registry without a readable start time", () => {
  test("#given an entry from an older version (no start time) #when its pid is alive #then it is alive while the entry is fresh and dead once it is stale", () => {
    const dir = summaryDir(stateDirs.make())
    const owner = { pid: 313_131, bootId: "older-version" }
    mkdirSync(join(dir, "owners"), { recursive: true })
    const path = join(dir, "owners", "313131.json")
    writeFileSync(path, JSON.stringify(owner))
    const now = Date.now()
    const isAlive = createOwnerLiveness({ dir, owner: { pid: 1_212, bootId: "reader" }, isPidAlive: () => true, now: () => now, processStartTime: () => "readable" })

    expect(isAlive(owner)).toBe(true)

    // when: the older owner wrote its entry more than the stale window ago and never refreshes it
    utimesSync(path, new Date(now - STALE), new Date(now - STALE))

    // then
    expect(isAlive(owner)).toBe(false)
    expect(existsSync(path)).toBe(false)
  })

  test("#given a platform where no start time can be read #when the owner's pid is alive #then it is alive while its entry heartbeat is fresh and dead once it is stale", () => {
    const dir = summaryDir(stateDirs.make())
    let clock = T0
    const owner = { pid: 414_141, bootId: "no-start-time" }
    createOwnerRegistry({ dir, owner, now: () => clock, processStartTime: () => null }).register()
    const isAlive = createOwnerLiveness({ dir, owner: { pid: 1_313, bootId: "reader" }, isPidAlive: () => true, now: () => clock, processStartTime: () => null })

    expect(isAlive(owner)).toBe(true)

    // when
    clock += STALE

    // then
    expect(isAlive(owner)).toBe(false)
  })

  test("#given an owner on such a platform that keeps writing #when the stale window passes #then its refreshed entry keeps it alive", async () => {
    const dir = stateDirs.make()
    const owner = createTestRecorder({ dir, pid: 717_171, startAt: T0, startTimes: () => null })
    await owner.summary.recordTurn("s1", summaryTurn())
    owner.advance(4 * 60_000)
    owner.tick()

    const isAlive = createOwnerLiveness({ dir: summaryDir(dir), owner: { pid: 1_414, bootId: "reader" }, isPidAlive: () => true, now: () => T0 + 8 * 60_000, processStartTime: () => null })
    expect(isAlive(owner.storage.owner)).toBe(true)
  })
})
