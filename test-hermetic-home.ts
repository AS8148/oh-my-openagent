/// <reference types="bun-types" />
import { afterAll } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { markTestInfrastructureDir, runTestTempRootTeardown } from "./test-temp-root"

const AGENT_DIR_ENV_NAMES = ["OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"] as const

export interface HermeticHome {
  readonly home: string
  readonly agentDir: string
}

// os.homedir() keeps the OS home it read at process start and ignores a later HOME change, so the
// engine's agent-dir lookup (these variables first, os.homedir() otherwise) would still land in the
// user's real agent dir: a test that starts a session or a task host then writes there (#9578).
// Every reader takes the first set name in OMO > SENPI > PI order. The two that a run inherited from
// a live omo session are dropped and only the LAST is pinned to the hermetic home, so a test that sets
// OMO_ or SENPI_CODING_AGENT_DIR for itself or a child still wins exactly as it did before.
export function installHermeticHome(): HermeticHome {
  const home = mkdtempSync(join(tmpdir(), "omo-test-home-"))
  markTestInfrastructureDir(home)
  process.env.HOME = home
  process.env.USERPROFILE = home
  // Both root and package-local preloads must override os.homedir()'s retained host memory root.
  process.env.OMO_MEMORY_HOME = join(home, ".omo", "memory")
  const agentDir = join(home, ".omo", "agent")
  for (const name of AGENT_DIR_ENV_NAMES) delete process.env[name]
  process.env.PI_CODING_AGENT_DIR = agentDir
  // The user skill roots follow these too: the OpenCode config dir falls back to os.homedir()/.config,
  // which the HOME change above does not move, and a developer's shell may export any of them. Left
  // alone, a user skill (a `ulw-plan` in ~/.config/opencode/skills) outranks the shared one (#10632).
  process.env.XDG_CONFIG_HOME = join(home, ".config")
  delete process.env.OPENCODE_CONFIG_DIR
  delete process.env.CLAUDE_CONFIG_DIR
  installHermeticSecrets()
  afterAll(async () => {
    // The temp-root teardown reads and removes the directory these hosts write into, so it waits for them
    // to exit, and it runs even when the shard check throws: a later preload afterAll does not run
    // once an earlier one has failed (#9766).
    await runCheckThenTeardown(async () => {
      const failures: unknown[] = []
      await stopRunTaskHosts(agentDir).catch((error: unknown) => failures.push(error))
      try {
        failOnShardsInRealAgentDir()
      } catch (error) {
        failures.push(error)
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, failures.map(describeError).join("\n"))
    }, runTestTempRootTeardown)
  })
  return { home, agentDir }
}

// The OS credential store ignores HOME: a test that reads sign-in state (memory sync reads the
// `omo login` credentials on every session bind) would see the developer's real credentials and
// could reach the live service. Each test process gets its own empty in-memory store instead.
function installHermeticSecrets(): void {
  const values = new Map<string, string>()
  const keyOf = (key: { readonly service: string; readonly name: string }) => `${key.service}\u0000${key.name}`
  Object.defineProperty(Bun, "secrets", {
    value: {
      get: async (key: { readonly service: string; readonly name: string }) => values.get(keyOf(key)) ?? null,
      set: async (key: { readonly service: string; readonly name: string; readonly value: string }) => {
        values.set(keyOf(key), key.value)
      },
      delete: async (key: { readonly service: string; readonly name: string }) => values.delete(keyOf(key)),
    },
  })
}

/** Runs the teardown after the check even when the check throws; when both throw, both errors are reported. */
export async function runCheckThenTeardown(
  check: () => Promise<void>,
  teardown: () => void | Promise<void>,
): Promise<void> {
  let checkFailure: { readonly error: unknown } | undefined
  try {
    await check()
  } catch (error) {
    checkFailure = { error }
  }
  try {
    await teardown()
  } catch (teardownError) {
    if (checkFailure) {
      // bun test prints only an AggregateError's own message, so both inner messages go into it.
      const errors = [checkFailure.error, teardownError]
      throw new AggregateError(errors, `The shard check and the temp-root teardown both failed (#9766):\n${errors.map(describeError).join("\n")}`)
    }
    throw teardownError
  }
  if (checkFailure) throw checkFailure.error
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The part of the engine's host API the teardown uses; tests pass their own. */
export interface TaskHostEngine {
  listHostEndpoints(agentDir: string): Promise<readonly { readonly socket: string | null; readonly endpoint_kind: string }[]>
  stopHost(options: { readonly socket: string; readonly agentDir: string; readonly force: boolean; readonly timeoutMs: number }): Promise<
    { readonly action: string; readonly pid?: number; readonly reason?: string }
  >
  probeHost(options: { readonly socket: string; readonly timeoutMs: number }): Promise<unknown>
}

// Bun's hook budget is 5 s for every file after the first unless --timeout is passed, so the whole host
// stop, engine load included, ends inside it and reports what is left instead of timing the hook out.
export const TASK_HOST_STOP_DEADLINE_MS = 3_000
const ENGINE_CALL_TIMEOUT_MS = 1_000

/**
 * Stops the task hosts this run started, within a deadline (#11630).
 *
 * A test that boots the packaged extension can start a real task host. The engine registers every host it
 * spawns in the agent dir it was given, with the host's pid and start time, and this run's agent dir is a
 * mkdtemp of its own: the hosts registered there are exactly the ones this run (or a child that inherited
 * its environment) started. The engine's own stop signals a host only after proving that its registration
 * names the live process, so nothing here decides from a process-table scan: a scan by path matched
 * processes this run never started, and its wait was unbounded under load.
 *
 * A host still running when the deadline passes, or one the engine cannot prove but that still answers on
 * its socket, fails the run by name rather than as an unnamed hook timeout.
 */
export async function stopRunTaskHosts(
  agentDir: string,
  options: { readonly deadlineMs?: number; readonly loadEngine?: () => Promise<TaskHostEngine> } = {},
): Promise<void> {
  if (!existsSync(join(agentDir, "rpc-host-daemon"))) return
  const deadlineMs = options.deadlineMs ?? TASK_HOST_STOP_DEADLINE_MS
  const loadEngine = options.loadEngine ?? loadTaskHostEngine
  const deadline = Date.now() + deadlineMs
  const unsettled = new Map<string, string>()
  const leftovers: string[] = []
  const stopAll = async (): Promise<void> => {
    const engine = await loadEngine()
    const sockets = (await engine.listHostEndpoints(agentDir))
      .filter((endpoint) => endpoint.endpoint_kind === "rpc_host")
      .flatMap((endpoint) => (endpoint.socket === null ? [] : [endpoint.socket]))
    for (const socket of sockets) unsettled.set(socket, "still stopping")
    await Promise.all(sockets.map(async (socket) => {
      const leftover = await stopOne(engine, agentDir, socket, deadline, (state) => unsettled.set(socket, state))
      unsettled.delete(socket)
      if (leftover !== undefined) leftovers.push(leftover)
    }))
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = await Promise.race([
    stopAll().then(
      () => false,
      (error: unknown) => {
        throw new Error(`Stopping the task hosts this run started failed (#11630): ${describeError(error)}`)
      },
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), Math.max(0, deadline - Date.now()))
    }),
  ]).finally(() => clearTimeout(timer))
  if (timedOut) {
    leftovers.push(...[...unsettled].map(([socket, state]) => `${socket} (${state})`))
    if (unsettled.size === 0) leftovers.push(`the engine did not list the host registry in ${agentDir} in time`)
  }
  if (leftovers.length === 0) return
  throw new Error(
    `Task hosts this run started were still running ${deadlineMs}ms into the end-of-run teardown (#11630):\n`
      + leftovers.map((leftover) => `  ${leftover}`).join("\n"),
  )
}

async function stopOne(
  engine: TaskHostEngine,
  agentDir: string,
  socket: string,
  deadline: number,
  progress: (state: string) => void,
): Promise<string | undefined> {
  const result = await engine.stopHost({ socket, agentDir, force: true, timeoutMs: ENGINE_CALL_TIMEOUT_MS })
  if (result.action === "stopped" && result.pid !== undefined) {
    progress(`pid ${result.pid} signalled, not exited`)
    if (await exitedBy(result.pid, deadline)) return undefined
    return `${socket} (pid ${result.pid} did not exit after SIGTERM)`
  }
  // A host that already exited has released its registration, so its stop is refused as unproven; one that
  // is still serving the socket is the leftover.
  progress(`stop refused (${result.reason ?? result.action}), probing`)
  const answer = await engine.probeHost({ socket, timeoutMs: ENGINE_CALL_TIMEOUT_MS })
  return answer === undefined ? undefined : `${socket} (stop refused: ${result.reason ?? result.action}; the host still answers)`
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH")
  }
}

async function exitedBy(pid: number, deadline: number): Promise<boolean> {
  while (processAlive(pid)) {
    if (Date.now() >= deadline) return false
    await Bun.sleep(25)
  }
  return true
}

async function loadTaskHostEngine(): Promise<TaskHostEngine> {
  const engine = await import("@code-yeongyu/senpi")
  return {
    listHostEndpoints: (agentDir) => engine.listHostEndpoints(agentDir),
    stopHost: (options) => engine.stopHost(options),
    probeHost: (options) => engine.probeHost(options),
  }
}

const REAL_AGENT_DIRS = [join(homedir(), ".omo", "agent"), join(homedir(), ".senpi", "agent"), join(homedir(), ".omo")]

// A host shard registered under a real agent dir by THIS test process is a leak. The shard meta
// records its creator, so a live session's own shards on the same machine are never counted.
function failOnShardsInRealAgentDir(): void {
  const leaked = REAL_AGENT_DIRS.flatMap((agentDir) => shardsCreatedBy(join(agentDir, "rpc", "shards"), process.pid))
  if (leaked.length === 0) return
  throw new Error(
    `test process ${process.pid} registered task host shards in the real agent dir (#9578): ${leaked.join(", ")}`,
  )
}

// A pid is reused, so a shard left by an earlier process that held this pid names it as creator too.
// Only a shard created at or after this process started can be this process's leak; a shard whose
// created_at cannot be parsed is still reported, so a malformed meta never hides a leak.
export function shardsCreatedBy(
  shardsDir: string,
  pid: number,
  startedAt: number = Date.now() - process.uptime() * 1000,
): string[] {
  let names: string[]
  try {
    names = readdirSync(shardsDir)
  } catch {
    return []
  }
  return names
    .filter((name) => name.endsWith(".meta.json"))
    .map((name) => join(shardsDir, name))
    .filter((metaPath) => {
      const meta = readShardMeta(metaPath)
      if (meta.created_by_pid !== pid) return false
      const createdAt = typeof meta.created_at === "string" ? Date.parse(meta.created_at) : Number.NaN
      return Number.isNaN(createdAt) || createdAt >= startedAt
    })
}

function readShardMeta(metaPath: string): { created_by_pid?: unknown; created_at?: unknown } {
  try {
    return JSON.parse(readFileSync(metaPath, "utf8")) as { created_by_pid?: unknown; created_at?: unknown }
  } catch {
    return {}
  }
}
