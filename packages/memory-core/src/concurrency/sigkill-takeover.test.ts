import { afterEach, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { memoryWriterLockPath, parseLockRecord } from "../locks"
import { isLockOwnerProvenDead } from "../locks/acquire"
import { probeUntil } from "../locks/process-liveness.test-support"
import {
  DEATH_PROOF_BOUND_MS,
  assertLinearCommits,
  assertRepoIntegrity,
  createConcurrencyKit,
  git,
  type ChildHarness,
} from "./two-process-kit.test-support"

const writerChildPath = fileURLToPath(new URL("./writer-child.ts", import.meta.url))
const crashCommitChildPath = fileURLToPath(new URL("./crash-commit-child.ts", import.meta.url))

const kit = createConcurrencyKit()
afterEach(kit.cleanup)

function spawnWriter(
  fixtureValue: Awaited<ReturnType<typeof kit.fixture>>,
  mode: "kill-holder" | "recovery",
  writerId: string,
): ChildHarness {
  return kit.harnessFor(writerChildPath, [
    mode,
    fixtureValue.identity.paths.repo,
    fixtureValue.identity.paths.locks,
    writerId,
    "10",
    fixtureValue.contentionPath,
  ])
}

async function expectTakeoverOwnerProvenDead(identity: Awaited<ReturnType<typeof kit.fixture>>["identity"], pid: number | undefined): Promise<void> {
  const record = parseLockRecord(await readFile(memoryWriterLockPath(identity.paths.locks), "utf8"))
  if (record === null || record.pid !== pid) throw new Error(`unexpected lock owner: ${JSON.stringify(record)}`)
  expect(await probeUntil(() => isLockOwnerProvenDead(record), DEATH_PROOF_BOUND_MS)).toBe(true)
}

describe("one memory identity across real Bun processes (omo #10177 crash consistency)", () => {
  test("#given a writer SIGKILLed while holding the shared lock #when its peer continues #then liveness takeover completes twenty clean commits", async () => {
    // #given
    const shared = await kit.fixture()
    const holder = spawnWriter(shared, "kill-holder", "holder")
    const survivor = spawnWriter(shared, "recovery", "survivor")
    await Promise.all([holder.waitForLine("ready"), survivor.waitForLine("ready")])
    const killReady = holder.waitForLine("kill-ready")

    // #when
    holder.send("go")
    survivor.send("go")
    await killReady
    holder.child.kill("SIGKILL")
    expect(await holder.exit).toEqual({ code: null, signal: "SIGKILL" })
    // The exit event only proves this parent reaped its child. Recovery starts once the lock
    // protocol's own oracle proves the recorded owner dead, so the survivor never spends its
    // acquire budget on an owner the OS has not yet let go of; a proof that never arrives fails here.
    await expectTakeoverOwnerProvenDead(shared.identity, holder.child.pid)
    await assertRepoIntegrity(shared.identity.paths.repo)
    survivor.send("begin-recovery")
    await survivor.waitForPrefix("done:")
    await kit.expectSuccessful(survivor)

    // #then
    await assertLinearCommits(shared.identity, 20)
  }, 30_000)

  test("#given a writer SIGKILLed inside its git commit #when its peer takes over #then every reachable object survives and twenty follow-up commits land", async () => {
    // #given
    const shared = await kit.fixture()
    const killer = kit.harnessFor(crashCommitChildPath, [
      "kill-mid-commit",
      shared.identity.paths.repo,
      shared.identity.paths.locks,
      "killer",
      "0",
      "30",
    ])

    // #when
    await killer.waitForLine("kill-ready")
    const killerExit = await killer.exit
    // SIGKILL is the interleaving under test; a clean exit means the self-kill timer missed the
    // commit window entirely, which is still a valid (normal-completion) sample.
    expect(killerExit.signal === "SIGKILL" || killerExit.code === 0, killer.failureContext()).toBe(true)
    if (killerExit.code !== 0) await expectTakeoverOwnerProvenDead(shared.identity, killer.child.pid)
    await assertRepoIntegrity(shared.identity.paths.repo)

    const peer = kit.harnessFor(crashCommitChildPath, [
      "peer",
      shared.identity.paths.repo,
      shared.identity.paths.locks,
      "peer",
      "20",
    ])
    await peer.waitForPrefix("done:")
    await kit.expectSuccessful(peer)

    // #then
    // git's ref transaction makes the orphan's commit CAS-fail once the peer has committed, so
    // history is always linear and the orphan contributes at most its one in-flight commit.
    const commitCount = Number.parseInt((await git(shared.identity.paths.repo, ["rev-list", "--count", "HEAD"])).trim(), 10)
    expect(commitCount).toBeGreaterThanOrEqual(20)
    expect(commitCount).toBeLessThanOrEqual(21)
    expect(Number.parseInt((await git(shared.identity.paths.repo, ["rev-list", "--count", "--merges", "HEAD"])).trim(), 10)).toBe(0)
    await assertRepoIntegrity(shared.identity.paths.repo)
  }, 30_000)

  // One row per point a killed `git commit` can strand its own lock file (git lockfile protocol:
  // the lock exists from create until rename, so a git process SIGKILLed while its lock exists can
  // never remove it). omo #10177: after such a kill, the peer's takeover must still leave a repo
  // whose every reachable object exists (fsck --strict clean) and whose history stays linear.
  const killTriggers = [
    { trigger: "index-lock", name: "index.lock" },
    { trigger: "ref-lock", name: "refs/heads/main.lock" },
  ] as const

  for (const { trigger, name } of killTriggers) {
    test(`#given a writer SIGKILLed with a stranded .git/${name} #when its peer takes over #then every reachable object survives and twenty follow-up commits land`, async () => {
      // #given
      const shared = await kit.fixture()
      const killer = kit.harnessFor(crashCommitChildPath, [
        "kill-at-git-lock",
        shared.identity.paths.repo,
        shared.identity.paths.locks,
        "killer",
        trigger,
      ])

      // #when
      await killer.waitForLine("kill-ready")
      const killerExit = await killer.exit
      expect(killerExit, killer.failureContext()).toEqual({ code: null, signal: "SIGKILL" })
      await expectTakeoverOwnerProvenDead(shared.identity, killer.child.pid)
      // fsck reads a stranded ref lock as badRefContent; that line is the debris under test, and
      // nothing else may be wrong. The strict (no-allowance) check after the peer's commits then
      // proves the sweep removed it.
      await assertRepoIntegrity(shared.identity.paths.repo, [
        new RegExp(`^error: refs/heads/main\\.lock: badRefContent`),
      ].filter(() => trigger === "ref-lock"))

      const peer = kit.harnessFor(crashCommitChildPath, [
        "peer",
        shared.identity.paths.repo,
        shared.identity.paths.locks,
        "peer",
        "20",
      ])
      await peer.waitForPrefix("done:")
      await kit.expectSuccessful(peer)

      // #then: the stranded commit dies with its git process, so history is the peer's twenty
      // linear commits plus, for the ref-lock row, the killer's completed root commit; the orphan
      // can never publish a ref past a stranded refs lock.
      await assertLinearCommits(shared.identity, trigger === "ref-lock" ? 21 : 20)
    }, 30_000)
  }
})
