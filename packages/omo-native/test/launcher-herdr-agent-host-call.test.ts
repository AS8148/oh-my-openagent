import { afterEach, describe, expect, test } from "bun:test"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const SOURCE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

type Spawned = { argv: string[]; HERDR_AGENT: string | null; marker: string | null }
type Run = { status: number | null; stderr: string; launches: Spawned[] }

/**
 * Runs a real omo command over a fake engine that records the environment of every launch. With
 * `platform`, the launcher runs under that process.platform (as the launcher tests do for linux),
 * so a platform-specific branch is exercised on every runner.
 */
function runOmo(args: readonly string[], env: Record<string, string>, platform?: NodeJS.Platform): Run {
  const root = mkdtempSync(join(tmpdir(), "omo-herdr-host-call-"))
  roots.push(root)
  const app = join(root, "app")
  cpSync(join(SOURCE_ROOT, "bin"), join(app, "bin"), { recursive: true })
  write(join(app, "package.json"), JSON.stringify({
    name: "omo-ai", version: "1.2.3-test.0", type: "module",
    dependencies: { "@code-yeongyu/senpi": "2026.8.9" },
  }))
  const senpi = join(app, "node_modules", "@code-yeongyu", "senpi")
  write(join(senpi, "package.json"), JSON.stringify({
    name: "@code-yeongyu/senpi", version: "2026.8.9", type: "module", exports: { ".": "./dist/index.js" },
  }))
  write(join(senpi, "dist", "index.js"), "export const fixture = true\n")
  write(join(senpi, "dist", "cli.js"), `import { appendFileSync } from "node:fs"
appendFileSync(process.env.CLI_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), HERDR_AGENT: process.env.HERDR_AGENT ?? null, marker: process.env.OMO_HERDR_AGENT_HINT ?? null }) + "\\n")
console.log("{}")
`)
  write(join(senpi, "dist", "core", "brand.js"), "export {}\n")
  for (const artifact of [
    "plugin/package.json", "plugin/extensions/omo.js", "plugin/runtime/lsp-daemon/dist/cli.js",
    "plugin/runtime/agent-toolkit/cli.js",
  ]) write(join(app, artifact), "fixture\n")
  const entry = join(app, "probe.mjs")
  write(entry, `${platform === undefined ? "" : `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} })\n`}const { runLauncher } = await import("./bin/lib/launcher.js")
await runLauncher(${JSON.stringify(args)})
`)
  const capture = join(root, "engine-launches.jsonl")
  const home = join(root, "home")
  mkdirSync(home, { recursive: true })
  const { HERDR_ENV: _env, HERDR_AGENT: _agent, OMO_HERDR_AGENT_HINT: _marker, ...inherited } = process.env
  const result = spawnSync(process.execPath, [entry], {
    encoding: "utf8",
    env: {
      ...inherited, HOME: home, XDG_DATA_HOME: join(root, "xdg"), CLI_CAPTURE: capture,
      OMO_CODING_AGENT_DIR: join(root, "agent"), SENPI_CODING_AGENT_DIR: join(root, "agent"), ...env,
    },
  })
  const launches = existsSync(capture)
    ? readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Spawned)
    : []
  return { status: result.status, stderr: result.stderr, launches }
}

const inheritedMarker = { HERDR_ENV: "1", HERDR_AGENT: "claude", OMO_HERDR_AGENT_HINT: "claude" }

function expectUserValueKept(launches: Spawned[]): void {
  expect(launches.length).toBeGreaterThan(0)
  for (const launch of launches) expect({ HERDR_AGENT: launch.HERDR_AGENT, marker: launch.marker }).toEqual({ HERDR_AGENT: "claude", marker: null })
}

// A host call merges its caller's environment into the engine's (engineHostCall), and the daemon
// and host-status callers pass the whole parent environment. An inherited OMO_HERDR_AGENT_HINT must
// not survive that merge: the task host and its RPC workers load the plugin, which would take a
// marker that matches a user-set HERDR_AGENT as the launcher's and remove the user's value (#10448).
describe("host calls never hand down an inherited herdr hint marker (#10448)", () => {
  test("#given a user-set HERDR_AGENT and a matching inherited marker #when `omo host status --all` starts the engine #then it keeps the user's value and gets no marker", () => {
    expectUserValueKept(runOmo(["host", "status", "--all"], inheritedMarker).launches)
  })

  // `omo daemon` needs a unix socket, so it refuses on win32 before starting anything (below).
  test.skipIf(process.platform === "win32")("#given a user-set HERDR_AGENT and a matching inherited marker #when `omo daemon status` starts the engine #then it keeps the user's value and gets no marker", () => {
    expectUserValueKept(runOmo(["daemon", "status"], inheritedMarker).launches)
  })

  test("#given win32 #when `omo daemon status` runs with an inherited marker #then it refuses before starting any engine, so no marker can reach one", () => {
    const run = runOmo(["daemon", "status"], inheritedMarker, "win32")
    expect(run.launches).toEqual([])
    expect(run.status).toBe(4)
    expect(run.stderr).toContain("omo daemon: a task host needs a unix socket, which win32 does not provide")
  })
})
