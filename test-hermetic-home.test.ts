import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { runCheckThenTeardown, shardsCreatedBy, stopRunTaskHosts, type TaskHostEngine } from "./test-hermetic-home"

describe("hermetic memory home (#9469)", () => {
  test("the preload pins memory inside the temporary home", () => {
    const home = process.env.HOME
    const memory = process.env.OMO_MEMORY_HOME
    expect(home).toBeDefined()
    expect(memory).toBeDefined()
    if (!home || !memory) throw new Error("missing hermetic home")
    const path = relative(home, memory)
    expect(path).toBe(join(".omo", "memory"))
    expect(isAbsolute(path)).toBe(false)
  })
})

describe("shardsCreatedBy (#9673)", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function shardsDirWith(createdBy: number, createdAt: Date): string {
    const dir = mkdtempSync(join(tmpdir(), "omo-shards-"))
    dirs.push(dir)
    writeFileSync(
      join(dir, "p-abc.meta.json"),
      JSON.stringify({ created_by_pid: createdBy, created_at: createdAt.toISOString() }),
    )
    return dir
  }

  const startedAt = Date.now() - 60_000

  test("ignores a shard naming this pid that was created before the process started", () => {
    const dir = shardsDirWith(process.pid, new Date(startedAt - 3 * 24 * 60 * 60 * 1000))
    expect(shardsCreatedBy(dir, process.pid, startedAt)).toEqual([])
  })

  test("reports a shard naming this pid that was created after the process started", () => {
    const dir = shardsDirWith(process.pid, new Date(startedAt + 1000))
    expect(shardsCreatedBy(dir, process.pid, startedAt)).toEqual([join(dir, "p-abc.meta.json")])
  })

  test("reports a shard naming this pid whose created_at cannot be parsed", () => {
    const dir = mkdtempSync(join(tmpdir(), "omo-shards-"))
    dirs.push(dir)
    writeFileSync(join(dir, "p-abc.meta.json"), JSON.stringify({ created_by_pid: process.pid, created_at: "not a date" }))
    expect(shardsCreatedBy(dir, process.pid, startedAt)).toEqual([join(dir, "p-abc.meta.json")])
  })

  test("ignores a shard created by another pid", () => {
    const dir = shardsDirWith(process.pid + 1, new Date(startedAt + 1000))
    expect(shardsCreatedBy(dir, process.pid, startedAt)).toEqual([])
  })
})

describe("runCheckThenTeardown (#9766)", () => {
  const fail = (message: string) => () => {
    throw new Error(message)
  }

  test("#given the check throws #when run #then the teardown still runs and the check error is thrown", async () => {
    let tornDown = false
    const run = runCheckThenTeardown(async () => fail("shards")(), () => {
      tornDown = true
    })

    await expect(run).rejects.toThrow("shards")
    expect(tornDown).toBe(true)
  })

  test("#given only the teardown throws #when run #then the teardown error is thrown", async () => {
    await expect(runCheckThenTeardown(async () => {}, fail("leftovers"))).rejects.toThrow("leftovers")
  })

  test("#given both throw #when run #then the thrown message carries both, since the runner prints only that", async () => {
    const error = await runCheckThenTeardown(async () => fail("shard p-1 leaked")(), fail("left omo-x-1")).catch(
      (caught: unknown) => caught,
    )

    if (!(error instanceof AggregateError)) throw new Error(`expected an AggregateError, got ${String(error)}`)
    expect(error.message).toContain("shard p-1 leaked")
    expect(error.message).toContain("left omo-x-1")
    expect(error.errors).toHaveLength(2)
  })

  test("#given an async teardown that rejects #when run #then the rejection is thrown", async () => {
    await expect(
      runCheckThenTeardown(async () => {}, async () => {
        throw new Error("async leftovers")
      }),
    ).rejects.toThrow("async leftovers")
  })
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("stopRunTaskHosts (#11630)", () => {
  const dirs: string[] = []
  const children: number[] = []
  afterAll(() => {
    for (const pid of children) if (alive(pid)) process.kill(pid, "SIGKILL")
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  function agentDirWithHosts(): string {
    const dir = mkdtempSync(join(tmpdir(), "omo-agent-"))
    dirs.push(dir)
    mkdirSync(join(dir, "rpc-host-daemon"))
    return dir
  }

  function sleeper(): number {
    const child = spawn("sleep", ["30"], { stdio: "ignore" })
    if (child.pid === undefined) throw new Error("sleep did not start")
    children.push(child.pid)
    return child.pid
  }

  function engine(overrides: Partial<TaskHostEngine>): TaskHostEngine {
    return {
      listHostEndpoints: async () => [{ socket: "/run/a.sock", endpoint_kind: "rpc_host" }],
      stopHost: async () => ({ action: "refuse", reason: "unknown_owner" }),
      probeHost: async () => undefined,
      ...overrides,
    }
  }

  test("#given no host registry in the agent dir #when torn down #then the engine is never loaded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omo-agent-"))
    dirs.push(dir)
    let loaded = false
    await stopRunTaskHosts(dir, { loadEngine: async () => { loaded = true; return engine({}) } })
    expect(loaded).toBe(false)
  })

  test("#given a registered host the engine stops #when it exits #then teardown resolves", async () => {
    const pid = sleeper()
    const stops: unknown[] = []
    await stopRunTaskHosts(agentDirWithHosts(), {
      loadEngine: async () => engine({
        stopHost: async (options) => {
          stops.push(options)
          process.kill(pid, "SIGTERM")
          return { action: "stopped", pid }
        },
      }),
    })
    expect(stops).toEqual([expect.objectContaining({ socket: "/run/a.sock", force: true })])
  })

  test("#given a host that was already gone #when the stop is refused and nothing answers #then teardown resolves", async () => {
    await stopRunTaskHosts(agentDirWithHosts(), { loadEngine: async () => engine({}) })
  })

  test("#given a terminal endpoint #when torn down #then only rpc hosts are stopped", async () => {
    const stopped: string[] = []
    await stopRunTaskHosts(agentDirWithHosts(), {
      loadEngine: async () => engine({
        listHostEndpoints: async () => [{ socket: "/run/t.sock", endpoint_kind: "tui" }, { socket: null, endpoint_kind: "rpc_host" }],
        stopHost: async (options) => {
          stopped.push(options.socket)
          return { action: "refuse", reason: "unknown_owner" }
        },
      }),
    })
    expect(stopped).toEqual([])
  })

  test("#given a stopped host that does not exit #when the deadline passes #then a named error names it", async () => {
    const pid = sleeper()
    const error = await stopRunTaskHosts(agentDirWithHosts(), {
      deadlineMs: 200,
      loadEngine: async () => engine({ stopHost: async () => ({ action: "stopped", pid }) }),
    }).catch((caught: unknown) => caught)
    expect(String(error)).toContain("#11630")
    expect(String(error)).toContain("/run/a.sock")
    expect(String(error)).toContain(`pid ${pid}`)
  })

  test("#given a host the engine cannot prove #when it still answers #then a named error names the refusal", async () => {
    const error = await stopRunTaskHosts(agentDirWithHosts(), {
      loadEngine: async () => engine({ probeHost: async () => ({ answered: true }) }),
    }).catch((caught: unknown) => caught)
    expect(String(error)).toContain("/run/a.sock")
    expect(String(error)).toContain("unknown_owner")
  })

  test("#given a stop that never settles #when the deadline passes #then teardown rejects within it, naming the host", async () => {
    const started = Date.now()
    const error = await stopRunTaskHosts(agentDirWithHosts(), {
      deadlineMs: 200,
      loadEngine: async () => engine({ stopHost: () => new Promise(() => {}) }),
    }).catch((caught: unknown) => caught)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(String(error)).toContain("/run/a.sock")
    expect(String(error)).toContain("still stopping")
  })

  test("#given an engine that never loads #when the deadline passes #then teardown rejects within it", async () => {
    const error = await stopRunTaskHosts(agentDirWithHosts(), {
      deadlineMs: 200,
      loadEngine: () => new Promise(() => {}),
    }).catch((caught: unknown) => caught)
    expect(String(error)).toContain("#11630")
  })
})
