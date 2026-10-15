import { afterEach, describe, expect, test } from "bun:test"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { buildIdentityPaths, type MemoryIdentity } from "../identity"
import { memoryWriterLockPath, parseLockRecord } from "../locks"
import { isLockOwnerProvenDead } from "../locks/acquire"
import { exitedWithin, probeUntil } from "../locks/process-liveness.test-support"
import { ReflectionReservationStore, type ReservationResult } from "../reflection/reservation"
import type { ReservedRun } from "../reflection/machine"
import { realpathSync } from "node:fs"

const writerChildPath = fileURLToPath(new URL("./writer-child.ts", import.meta.url))
const reflectionChildPath = fileURLToPath(new URL("./reflection-child.ts", import.meta.url))
const crashCommitChildPath = fileURLToPath(new URL("./crash-commit-child.ts", import.meta.url))
const temporaryDirectories: string[] = []
const liveChildren = new Set<ChildProcessWithoutNullStreams>()

const TEARDOWN_GRACE_MS = 2_000
const DEATH_PROOF_BOUND_MS = 5_000
const FIXTURE_REMOVAL_BOUND_MS = 5_000

type Exit = { readonly code: number | null; readonly signal: NodeJS.Signals | null }

type LineWaiter = {
  readonly predicate: (line: string) => boolean
  readonly resolve: (line: string) => void
  readonly reject: (error: Error) => void
}

class ChildHarness {
  readonly child: ChildProcessWithoutNullStreams
  readonly exit: Promise<Exit>
  private readonly lines: string[] = []
  private readonly waiters: LineWaiter[] = []
  private stderr = ""
  private stdoutBuffer = ""
  private closed = false

  constructor(script: string, args: readonly string[]) {
    this.child = spawn(process.execPath, [script, ...args], { stdio: ["pipe", "pipe", "pipe"] })
    liveChildren.add(this.child)
    this.child.stderr.setEncoding("utf8")
    this.child.stderr.on("data", (chunk: string) => { this.stderr += chunk })
    this.child.stdout.setEncoding("utf8")
    this.child.stdout.on("data", (chunk: string) => this.acceptOutput(chunk))
    this.exit = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        liveChildren.delete(this.child)
        resolve({ code, signal })
      })
    })
    // `close` follows the last stdout byte, so a child that died before printing the awaited line
    // fails its waiters now, with its output attached, instead of surfacing as an opaque timeout.
    this.child.once("close", () => {
      this.closed = true
      for (const waiter of this.waiters.splice(0)) waiter.reject(this.exitedWithoutLine())
    })
  }

  send(message: string): void {
    this.child.stdin.write(`${message}\n`)
  }

  waitForLine(expected: string): Promise<string> {
    return this.waitFor((line) => line === expected)
  }

  waitForPrefix(prefix: string): Promise<string> {
    return this.waitFor((line) => line.startsWith(prefix))
  }

  failureContext(): string {
    return `stdout=${JSON.stringify(this.lines)} stderr=${JSON.stringify(this.stderr)}`
  }

  private waitFor(predicate: (line: string) => boolean): Promise<string> {
    const existing = this.lines.find(predicate)
    if (existing !== undefined) return Promise.resolve(existing)
    if (this.closed) return Promise.reject(this.exitedWithoutLine())
    return new Promise((resolve, reject) => this.waiters.push({ predicate, resolve, reject }))
  }

  private exitedWithoutLine(): Error {
    return new Error(`child pid ${String(this.child.pid)} exited before the awaited line: ${this.failureContext()}`)
  }

  private acceptOutput(chunk: string): void {
    this.stdoutBuffer += chunk
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n")
      if (newline < 0) return
      const line = this.stdoutBuffer.slice(0, newline)
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      this.lines.push(line)
      for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
        const waiter = this.waiters[index]
        if (waiter?.predicate(line)) {
          this.waiters.splice(index, 1)
          waiter.resolve(line)
        }
      }
    }
  }
}

async function git(repoPath: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repoPath, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr}`)
  return stdout
}

async function fixture(): Promise<{
  readonly root: string
  readonly identity: MemoryIdentity
  readonly contentionPath: string
}> {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "memory-two-process-")))
  temporaryDirectories.push(root)
  const identity: MemoryIdentity = {
    id: "shared-agent",
    safeSlug: "shared-agent",
    paths: buildIdentityPaths(root, "shared-agent"),
  }
  await mkdir(identity.paths.repo, { recursive: true })
  await git(identity.paths.repo, ["init", "-b", "main"])
  await git(identity.paths.repo, ["config", "commit.gpgsign", "false"])
  const contentionPath = join(root, "contention-attempts.log")
  await writeFile(contentionPath, "")
  return { root, identity, contentionPath }
}

function spawnWriter(
  fixtureValue: Awaited<ReturnType<typeof fixture>>,
  mode: "normal" | "kill-holder" | "recovery",
  writerId: string,
): ChildHarness {
  return new ChildHarness(writerChildPath, [
    mode,
    fixtureValue.identity.paths.repo,
    fixtureValue.identity.paths.locks,
    writerId,
    "10",
    fixtureValue.contentionPath,
  ])
}

async function expectSuccessful(child: ChildHarness): Promise<void> {
  const exit = await child.exit
  expect(exit, child.failureContext()).toEqual({ code: 0, signal: null })
}

// `git fsck --full --strict` is the integrity oracle for omo #10177: any error/fatal line, any
// missing or corrupt object, or a non-zero exit fails. A commit interrupted by SIGKILL can leave
// the objects it wrote unreachable (dangling); those are the normal debris of a killed write, not
// corruption, so they are reported but never fail the check.
async function assertRepoIntegrity(repoPath: string): Promise<void> {
  const child = Bun.spawn(["git", "-C", repoPath, "fsck", "--full", "--strict"], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const report = `${stdout}\n${stderr}`
  const broken = report.split("\n").filter((line) => /^(error|fatal):/.test(line) || /missing|corrupt/i.test(line))
  expect({ exitCode, broken }, report).toEqual({ exitCode: 0, broken: [] })
}

async function assertLinearCommits(identity: MemoryIdentity, expectedCount: number): Promise<void> {
  expect(Number.parseInt((await git(identity.paths.repo, ["rev-list", "--count", "HEAD"])).trim(), 10)).toBe(expectedCount)
  expect(Number.parseInt((await git(identity.paths.repo, ["rev-list", "--count", "--merges", "HEAD"])).trim(), 10)).toBe(0)
  await assertRepoIntegrity(identity.paths.repo)
}

async function assertTwentyLinearCommits(identity: MemoryIdentity): Promise<void> {
  await assertLinearCommits(identity, 20)
}

// Bun's fs.rm accepts maxRetries/retryDelay but never retries (bun-v1.4.2 node_fs.rs), so the wait
// for Windows to release a just-exited child's handles lives here: bounded, loud when they never go.
async function removeFixtureRoot(directory: string): Promise<void> {
  let lastError: unknown
  const removed = await probeUntil(async () => {
    try {
      await rm(directory, { recursive: true, force: true })
      return true
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw error
      lastError = error
      return false
    }
  }, FIXTURE_REMOVAL_BOUND_MS, 200)
  if (!removed) throw new Error(`fixture root ${directory} still busy after ${String(FIXTURE_REMOVAL_BOUND_MS)}ms`, { cause: lastError })
}

afterEach(async () => {
  // Temp roots die only after every tracked child is confirmed exited: rm under a live lock
  // holder strands it, and a fire-and-forget SIGKILL is not a confirmation.
  const tracked = [...liveChildren]
  liveChildren.clear()
  for (const child of tracked) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    child.kill("SIGTERM")
    if (!(await exitedWithin(child, TEARDOWN_GRACE_MS))) {
      child.kill("SIGKILL")
      if (!(await exitedWithin(child, TEARDOWN_GRACE_MS))) {
        throw new Error(`tracked child pid ${String(child.pid)} survived SIGTERM and SIGKILL teardown`)
      }
    }
  }
  await Promise.all(temporaryDirectories.splice(0).map(removeFixtureRoot))
})

describe("one memory identity across real Bun processes", () => {
  test("#given two synchronized tool writers #when each makes ten writes #then twenty linear commits land with observed lock contention", async () => {
    // #given
    const shared = await fixture()
    const first = spawnWriter(shared, "normal", "first")
    const second = spawnWriter(shared, "normal", "second")
    await Promise.all([first.waitForLine("ready"), second.waitForLine("ready")])
    const holding = Promise.race([first.waitForLine("holding"), second.waitForLine("holding")])
    const contended = Promise.race([first.waitForLine("contended"), second.waitForLine("contended")])

    // #when
    first.send("go")
    second.send("go")
    await Promise.all([holding, contended])
    first.send("release-first")
    second.send("release-first")
    await Promise.all([first.waitForPrefix("done:"), second.waitForPrefix("done:")])
    await Promise.all([expectSuccessful(first), expectSuccessful(second)])

    // #then
    const contentionAttempts = (await readFile(shared.contentionPath, "utf8")).split("\n").filter(Boolean)
    expect(contentionAttempts.length).toBeGreaterThanOrEqual(1)
    await assertTwentyLinearCommits(shared.identity)
  }, 30_000)

  test("#given two synchronized reflection reservers #when they race one identity #then one is active, one is pending, and completion promotes pending", async () => {
    // #given
    const shared = await fixture()
    const first = new ChildHarness(reflectionChildPath, [shared.root, shared.identity.id, "reflection-first"])
    const second = new ChildHarness(reflectionChildPath, [shared.root, shared.identity.id, "reflection-second"])
    await Promise.all([first.waitForLine("ready"), second.waitForLine("ready")])
    const firstResultLine = first.waitForPrefix("result:")
    const secondResultLine = second.waitForPrefix("result:")

    // #when
    first.send("go")
    second.send("go")
    const resultLines = await Promise.all([firstResultLine, secondResultLine])
    await Promise.all([expectSuccessful(first), expectSuccessful(second)])
    const results = resultLines.map((line) => JSON.parse(line.slice("result:".length)) as ReservationResult)

    // #then
    expect(results.map((result) => result.status).sort()).toEqual(["active", "pending"])
    const activeRecord = JSON.parse(await readFile(join(shared.identity.paths.reflection, "active.lock"), "utf8")) as ReservedRun
    const pendingRecord = JSON.parse(await readFile(join(shared.identity.paths.reflection, "pending.json"), "utf8")) as ReservedRun
    expect(activeRecord.runId).not.toBe(pendingRecord.runId)

    const store = new ReflectionReservationStore({
      identity: shared.identity,
      config: {},
      getJournal: async (conversationId) => {
        throw new Error(`unexpected journal access: ${conversationId}`)
      },
    })
    const completion = await store.complete(activeRecord.runId, "failed")
    const promoted = await store.readState()
    expect(completion.launch?.runId).toBe(pendingRecord.runId)
    expect(promoted.active?.runId).toBe(pendingRecord.runId)
    expect(promoted.pending).toBeUndefined()
    expect((JSON.parse(await readFile(join(shared.identity.paths.reflection, "active.lock"), "utf8")) as ReservedRun).runId).toBe(pendingRecord.runId)
  }, 30_000)

  test("#given a writer SIGKILLed while holding the shared lock #when its peer continues #then liveness takeover completes twenty clean commits", async () => {
    // #given
    const shared = await fixture()
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
    const holderRecord = parseLockRecord(await readFile(memoryWriterLockPath(shared.identity.paths.locks), "utf8"))
    if (holderRecord === null || holderRecord.pid !== holder.child.pid) throw new Error(`unexpected lock owner: ${JSON.stringify(holderRecord)}`)
    expect(await probeUntil(() => isLockOwnerProvenDead(holderRecord), DEATH_PROOF_BOUND_MS)).toBe(true)
    await assertRepoIntegrity(shared.identity.paths.repo)
    survivor.send("begin-recovery")
    await survivor.waitForPrefix("done:")
    await expectSuccessful(survivor)

    // #then
    await assertTwentyLinearCommits(shared.identity)
  }, 30_000)

  test("#given a writer SIGKILLed inside its git commit #when its peer takes over #then every reachable object survives and twenty follow-up commits land", async () => {
    // #given
    const shared = await fixture()
    const killer = new ChildHarness(crashCommitChildPath, [
      "kill-mid-commit",
      shared.identity.paths.repo,
      shared.identity.paths.locks,
      "killer",
      "0",
      "30",
    ])

    // #when
    const killReady = killer.waitForLine("kill-ready")
    await killReady
    const killerExit = await killer.exit
    // SIGKILL is the interleaving under test; a clean exit means the self-kill timer missed the
    // commit window entirely, which is still a valid (normal-completion) sample.
    expect(killerExit.signal === "SIGKILL" || killerExit.code === 0, killer.failureContext()).toBe(true)
    const killerCommitted = killerExit.code === 0
    if (!killerCommitted) {
      const killerRecord = parseLockRecord(await readFile(memoryWriterLockPath(shared.identity.paths.locks), "utf8"))
      if (killerRecord === null || killerRecord.pid !== killer.child.pid) throw new Error(`unexpected lock owner: ${JSON.stringify(killerRecord)}`)
      expect(await probeUntil(() => isLockOwnerProvenDead(killerRecord), DEATH_PROOF_BOUND_MS)).toBe(true)
    }
    await assertRepoIntegrity(shared.identity.paths.repo)

    const peer = new ChildHarness(crashCommitChildPath, [
      "peer",
      shared.identity.paths.repo,
      shared.identity.paths.locks,
      "peer",
      "20",
    ])
    await peer.waitForPrefix("done:")
    await expectSuccessful(peer)

    // #then
    // git's ref transaction makes the orphan's commit CAS-fail once the peer has committed, so
    // history is always linear and the orphan contributes at most its one in-flight commit.
    const commitCount = Number.parseInt((await git(shared.identity.paths.repo, ["rev-list", "--count", "HEAD"])).trim(), 10)
    expect(commitCount).toBeGreaterThanOrEqual(20)
    expect(commitCount).toBeLessThanOrEqual(21)
    expect(Number.parseInt((await git(shared.identity.paths.repo, ["rev-list", "--count", "--merges", "HEAD"])).trim(), 10)).toBe(0)
    await assertRepoIntegrity(shared.identity.paths.repo)
  }, 30_000)
})
