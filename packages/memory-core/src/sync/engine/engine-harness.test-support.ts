// Devices for the engine tests: a real git repo per device (so the Sync-Seq reconciliation runs
// against real commits), a fake item store, the fake crypto, an in-process lock and a manual
// clock. `restart` builds a fresh engine over the same directories, as a process restart would.

import { copyFile, cp, mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { SyncEngine, type EngineFault } from "./engine"
import { FakeSealer, FakeVerifier } from "./fake-crypto.test-support"
import type { FakeSyncServer } from "./fake-server.test-support"
import { FakeItemStore } from "./fake-store.test-support"
import type { Clock, SyncRepo, Transport, WriterLock } from "./ports"

export const ACCOUNT = "acc_test"
/** Every engine test drives real git processes; under machine load a cycle can take seconds. */
export const GIT_TEST_TIMEOUT = 30_000

async function git(cwd: string, ...args: string[]): Promise<string> {
  return gitWith(cwd, {}, ...args)
}

async function gitWith(cwd: string, env: Record<string, string>, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", ...env } })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err.trim()}`)
  return out.trim()
}

export async function gitRepo(root: string, existing = false): Promise<SyncRepo> {
  if (!existing) {
    await git(root, "init", "-q", "-b", "main")
    await git(root, "config", "user.name", "Test Agent")
    await git(root, "config", "user.email", "agent@example.invalid")
    await git(root, "config", "commit.gpgsign", "false")
    await writeFile(join(root, ".gitkeep"), "")
    await git(root, "add", ".gitkeep")
    await git(root, "commit", "-q", "-m", "init")
  }
  return {
    root,
    gitDir: join(root, ".git"),
    head: async () => git(root, "rev-parse", "HEAD"),
    headTree: async () => git(root, "rev-parse", "HEAD^{tree}"),
    stageTree: async (paths) => {
      const index = join(root, ".git", "omo-sync-index.tmp")
      await copyFile(join(root, ".git", "index"), index)
      try {
        await gitWith(root, { GIT_INDEX_FILE: index }, "add", "-A", "--", ...paths)
        return await gitWith(root, { GIT_INDEX_FILE: index }, "write-tree")
      } finally {
        await rm(index, { force: true })
      }
    },
    commit: async (paths, message) => {
      await git(root, "add", "-A", "--", ...paths)
      await git(root, "-c", "user.name=OmO Sync", "-c", "user.email=sync@omo.invalid", "commit", "-q", "-m", message, "--", ...paths)
      return git(root, "rev-parse", "HEAD")
    },
    hasSyncCommit: async (range) => (await git(root, "log", "--format=%(trailers:key=Sync-Seq,valueonly)", "HEAD")).split("\n").includes(range),
  }
}

export class ManualClock implements Clock {
  private at = 1_800_000_000_000
  private timers: { readonly due: number; readonly fn: () => void; cancelled: boolean }[] = []
  private waiting: (() => void)[] = []

  /** Resolves once some timer is scheduled: subscribe-first, so a test advances only after the engine waits. */
  untilPending(): Promise<void> {
    if (this.timers.some((t) => !t.cancelled)) return Promise.resolve()
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  now(): number {
    return this.at
  }

  after(ms: number, fn: () => void): () => void {
    const timer = { due: this.at + ms, fn, cancelled: false }
    this.timers.push(timer)
    for (const wake of this.waiting.splice(0)) wake()
    return () => {
      timer.cancelled = true
    }
  }

  /** Moves time forward, firing every timer that falls due, in order. */
  advance(ms: number): void {
    const until = this.at + ms
    for (;;) {
      const next = this.timers.filter((t) => !t.cancelled && t.due <= until).sort((a, b) => a.due - b.due)[0]
      if (next === undefined) break
      next.cancelled = true
      this.at = next.due
      next.fn()
    }
    this.at = until
  }
}

export const inProcessLock = (): WriterLock & { held: boolean } => {
  let chain: Promise<unknown> = Promise.resolve()
  const lock = {
    held: false,
    withLock<T>(fn: () => Promise<T>): Promise<T> {
      const run = chain.then(async () => {
        lock.held = true
        try {
          return await fn()
        } finally {
          lock.held = false
        }
      })
      chain = run.catch(() => undefined)
      return run
    },
  }
  return lock
}

/** The transport refuses every network call made while the writer lock is held (sync-design §5). */
function lockGuarded(transport: Transport, lock: { readonly held: boolean }): Transport {
  const guard = <A extends unknown[], R>(name: string, fn: (...args: A) => R) => (...args: A): R => {
    if (lock.held) throw new Error(`network call ${name} while the writer lock is held`)
    return fn(...args)
  }
  return {
    pull: guard("pull", transport.pull),
    download: guard("download", transport.download),
    reserve: guard("reserve", transport.reserve),
    upload: guard("upload", transport.upload),
    append: guard("append", transport.append),
    subscribe: transport.subscribe,
  }
}

export interface Device {
  readonly name: string
  readonly repo: SyncRepo
  readonly clock: ManualClock
  engine: SyncEngine
  store: FakeItemStore
  readonly verifier: FakeVerifier
  write(key: string, text: string | null): Promise<void>
  read(key: string): Promise<string | null>
  /** A fresh engine over the same directories; `fault` crashes it at a journal marker. */
  restart(fault?: EngineFault): Promise<void>
  syncCommits(): Promise<string[]>
  workingTempFiles(): Promise<string[]>
  retiredJournals(): Promise<string[]>
  dispose(): Promise<void>
}

export interface DeviceOptions {
  readonly batchBytes?: number
  /** Start from a copy of another device's memory dir (its .git and journal included). */
  readonly memoryFrom?: string
}

export async function makeDevice(server: FakeSyncServer, name: string, fault?: EngineFault, options: DeviceOptions = {}): Promise<Device> {
  const base = await mkdtemp(join(tmpdir(), `omo-sync-${name}-`))
  const root = join(base, "memory")
  const stateDir = join(base, "device")
  await mkdir(stateDir, { recursive: true })
  if (options.memoryFrom === undefined) await mkdir(root, { recursive: true })
  else await cp(options.memoryFrom, root, { recursive: true })
  const repo = await gitRepo(root, options.memoryFrom !== undefined)
  const clock = new ManualClock()
  const verifier = new FakeVerifier(ACCOUNT)
  const build = (f?: EngineFault) => {
    const store = new FakeItemStore(stateDir, name)
    const lock = inProcessLock()
    const engine = new SyncEngine({
      repo,
      store,
      transport: lockGuarded(server.transport(`device:${name}`), lock),
      verifier,
      sealer: new FakeSealer(ACCOUNT),
      lock,
      clock,
      random: () => 0,
      ...(options.batchBytes === undefined ? {} : { batchBytes: options.batchBytes }),
      ...(f === undefined ? {} : { fault: f }),
    })
    return { store, engine }
  }
  const device: Device = {
    name,
    repo,
    clock,
    verifier,
    ...build(fault),
    async write(key, text) {
      const path = join(root, key)
      if (text === null) return rm(path, { force: true })
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, text)
    },
    async read(key) {
      return readFile(join(root, key), "utf8").catch(() => null)
    },
    async restart(f) {
      Object.assign(device, build(f))
    },
    async syncCommits() {
      const out = await git(root, "log", "--format=%(trailers:key=Sync-Seq,valueonly)", "HEAD")
      return out.split("\n").filter((l) => l !== "")
    },
    async workingTempFiles() {
      const names = await readdir(root, { recursive: true })
      return names.filter((n) => String(n).includes(".omo-sync-tmp-"))
    },
    async retiredJournals() {
      return (await readdir(join(root, ".git"))).filter((n) => n.startsWith("omo-sync.retired-"))
    },
    dispose: () => rm(base, { recursive: true, force: true }),
  }
  return device
}
