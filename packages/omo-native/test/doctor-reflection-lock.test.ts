import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { classifyReflectionLock, formatReflectionLockLines, reflectionLockReport } from "../bin/lib/doctor-reflection-lock.js"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const HOST = "this-host"

function write(path: string, content: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content))
}

function memoryHome() {
  const root = mkdtempSync(join(tmpdir(), "omo-doctor-reflection-lock-"))
  roots.push(root)
  return root
}

function identity(root: string, id: string, durable = true): string {
  const identityRoot = join(root, "agents", id)
  mkdirSync(identityRoot, { recursive: true })
  if (durable) mkdirSync(join(identityRoot, "repo"), { recursive: true })
  return join(identityRoot, "runtime", "reflection")
}

function lock(reflectionDir: string, fields: Record<string, unknown> = {}): void {
  write(join(reflectionDir, "active.lock"), { runId: "reflection-run-64", launcherPid: 11096, launcherHostname: HOST, ...fields })
}

function outcome(reflectionDir: string): void {
  write(join(reflectionDir, "runs", "reflection-run-64", "outcome.json"), { version: 1, runId: "reflection-run-64" })
}

function claim(reflectionDir: string, claimantPid: number): void {
  write(join(reflectionDir, "runs", "reflection-run-64", "terminal-claim.json"), { version: 1, kind: "publish", runId: "reflection-run-64", attempt: 1, claimantPid })
}

const seams = (liveness: (pid: number) => "alive" | "dead" | "unknown") => ({ liveness, hostname: () => HOST })

describe("omo doctor reflection lock (#10377)", () => {
  test("#given no active.lock #when classified #then nothing is reported", () => {
    const dir = identity(memoryHome(), "agent-a")
    expect(classifyReflectionLock(dir, seams(() => "dead"))).toEqual({ state: "none" })
  })

  test("#given a launcher that is alive #when classified #then it is live and nothing is reported", () => {
    const dir = identity(memoryHome(), "agent-a")
    lock(dir)
    const verdict = classifyReflectionLock(dir, seams(() => "alive"))
    expect(verdict).toEqual({ state: "live", runId: "reflection-run-64" })
    expect(formatReflectionLockLines("agent-a", verdict, dir)).toEqual([])
  })

  test("#given the launcher and the publish claimant are dead and the outcome is recorded #when classified #then it is dead and the line names the next step", () => {
    const dir = identity(memoryHome(), "agent-a")
    lock(dir)
    outcome(dir)
    claim(dir, 4200)
    const verdict = classifyReflectionLock(dir, seams(() => "dead"))
    expect(verdict).toEqual({ state: "dead", runId: "reflection-run-64" })
    const [line] = formatReflectionLockLines("agent-a", verdict, dir)
    expect(line).toStartWith("WARN memory reflection is stuck on a stale lock (agent-a): run reflection-run-64")
    expect(line).toContain("Next step: open a session and send /reflect")
  })

  test("#given the launcher is dead but the publish claimant is alive #when classified #then it is live", () => {
    const dir = identity(memoryHome(), "agent-a")
    lock(dir)
    outcome(dir)
    claim(dir, 4200)
    expect(classifyReflectionLock(dir, seams((pid) => (pid === 4200 ? "alive" : "dead")))).toEqual({ state: "live", runId: "reflection-run-64" })
  })

  test.each([
    ["the launcher cannot be checked", (dir: string) => { lock(dir); outcome(dir) }, () => "unknown" as const, "launcher pid 11096 could not be checked"],
    ["the run recorded no outcome", (dir: string) => { lock(dir) }, () => "dead" as const, "launcher pid 11096 is gone and the run recorded no outcome"],
    ["another host owns the lock", (dir: string) => { lock(dir, { launcherHostname: "other-host" }) }, () => "dead" as const, "it is owned by host other-host"],
    ["the publish claimant cannot be checked", (dir: string) => { lock(dir); outcome(dir); claim(dir, 4200) }, (pid: number) => (pid === 4200 ? "unknown" as const : "dead" as const), "publish claimant pid 4200 could not be checked"],
    ["the launcher identity is missing", (dir: string) => { write(join(dir, "active.lock"), { runId: "reflection-run-64" }) }, () => "dead" as const, "its launcher identity is missing"],
    ["active.lock is not JSON", (dir: string) => { write(join(dir, "active.lock"), "{not json") }, () => "dead" as const, "active.lock is not valid JSON"],
  ])("#given %s #when classified #then nothing is reclaimed and it is reported as stuck with the next step", (_name, arrange, liveness, reason) => {
    const dir = identity(memoryHome(), "agent-a")
    arrange(dir)
    const verdict = classifyReflectionLock(dir, seams(liveness))
    expect(verdict.state).toBe("stuck")
    const [line] = formatReflectionLockLines("agent-a", verdict, dir)
    expect(line).toContain(reason)
    expect(line).toContain("Next step: run /doctor in a session")
  })

  test("#given a memory home with a stuck durable identity and a transient one #when the report runs #then only the durable identity is reported", () => {
    const root = memoryHome()
    const durable = identity(root, "agent-a")
    lock(durable)
    const transient = identity(root, "transient-x", false)
    lock(transient)
    const lines = reflectionLockReport({ env: { OMO_MEMORY_HOME: root }, reflectionLockSeams: seams(() => "unknown") })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("(agent-a)")
  })

  test("#given no memory home on disk #when the report runs #then it prints nothing", () => {
    expect(reflectionLockReport({ env: { OMO_MEMORY_HOME: join(memoryHome(), "missing") } })).toEqual([])
  })
})
