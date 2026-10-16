import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { shouldDisableTelemetry } from "../../../telemetry-core/src/env.ts"
import { isolatedChildEnv } from "./sandbox-child-env.mjs"
import {
  TELEMETRY_OPT_OUT_NAMES,
  telemetryLocalSinkEnv,
  withTelemetryOptOut,
} from "./telemetry-opt-out-env.mjs"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..")
const disabled = (env) => shouldDisableTelemetry({ env, productEnvPrefix: "OMO_SENPI" })

// A QA source that launches a process, forwards the caller's environment, and names the runtime is a
// driver that can boot the real plugin. It must build that environment through the shared helper.
const SPAWN = /\b(?:spawn|spawnSync|execFile|execFileSync|fork|Bun\.spawn|Bun\.spawnSync)\s*\(/u
const RUNTIME = /senpi|omo-native|binary-runtime|plugin\/extensions|omo-ai/iu
const HELPER = /\b(?:withTelemetryOptOut|telemetryLocalSinkEnv|isolatedChildEnv)\b/u

// Drivers the scan flags that launch no omo runtime of their own, or hand the runtime an environment
// another module already built through the helper. Each entry says which.
const NO_RUNTIME_SPAWN = {
  "packages/omo-senpi/scripts/qa/agent-toolkit-eval-sdk-qa.mjs": "worker env is isolatedEnvironment from agent-toolkit-eval-sdk-qa-support.mjs",
  "packages/omo-senpi/scripts/qa/fixtures/policy-continuation-extension.ts": "runs inside the opted-out child; spawns only the agent toolkit",
  "packages/omo-senpi/scripts/qa/kibitzer-sidecar-tui-qa.mjs": "env is sandboxEnv from kibitzer-sidecar-support.mjs (isolatedChildEnv)",
  "packages/omo-senpi/scripts/qa/package-dir-hygiene-probe.mjs": "its only child is this script re-run to report its own env; no runtime boots",
  "packages/omo-senpi/scripts/qa/session-dag-selector-pty.mjs": "env is passed in by session-dag-resume-qa.mjs",
  "packages/omo-senpi/scripts/qa/task-host-e2e-gateway-cost.mjs": "extension fixture; spawns sysctl only",
  "packages/omo-senpi/scripts/qa/task-host-e2e-shards-contracts.mjs": "runs bun unit tests, which inject their own env",
  "packages/omo-senpi/scripts/qa/task-shutdown-process.mjs": "worker env is isolatedEnvironment from agent-toolkit-eval-sdk-qa-support.mjs",
  "packages/omo-senpi/scripts/qa/team-delete-6413-qa.mjs": "senpi runs through drive.mjs runSenpi (isolatedChildEnv); spawns ps/pgrep only",
  "packages/omo-senpi/scripts/qa/thread-tools/lib/harness.mjs": "env is scratch.env from thread-tools/lib/gateway.mjs",
  "packages/omo-senpi/scripts/qa/thread-tools/session-control-qa.mjs": "env is scratch.env from thread-tools/lib/gateway.mjs",
  "script/qa/desktop/windows/engine.ts": "launches the desktop engine binary, which carries no omo telemetry",
  "script/qa/omo-native-telemetry-capture.mjs": "launches the loopback capture server only",
  "script/qa/omp-item2-measure.ts": "spawns git only",
  "script/qa/omp-item6-harness.ts": "spawns git only",
  "script/qa/omp-item9.ts": "spawns git only",
}

function qaSources() {
  const listed = execFileSync("git", ["ls-files", "script/qa/**", "packages/*/scripts/qa/**"], { cwd: repoRoot, encoding: "utf8" })
  return listed.split("\n").filter((path) => /\.(?:mjs|cjs|js|ts)$/u.test(path) && !/\.test\./u.test(path))
}

export function findUnroutedDrivers(files) {
  return files
    .filter(({ source }) => SPAWN.test(source) && /process\.env/u.test(source) && RUNTIME.test(source))
    .filter(({ path, source }) => !HELPER.test(source) && NO_RUNTIME_SPAWN[path] === undefined)
    .map(({ path }) => path)
}

describe("withTelemetryOptOut", () => {
  test("#given a caller that opted in #when the child env is built #then every telemetry gate reads it as opted out", () => {
    const env = withTelemetryOptOut({ PATH: "/bin", DO_NOT_TRACK: "0", OMO_DISABLE_TELEMETRY: "0" })

    expect(env).toEqual({ PATH: "/bin", DO_NOT_TRACK: "1", OMO_DISABLE_TELEMETRY: "1" })
    expect(disabled(env)).toBe(true)
    expect(disabled({ OMO_DISABLE_TELEMETRY: "1" })).toBe(true)
  })

  test("#given isolatedChildEnv #when a sandbox env is built #then it goes through the same opt-out", () => {
    expect(disabled(isolatedChildEnv({ PATH: "/bin" }, "/tmp/sbx/agent"))).toBe(true)
  })

  test("#given a telemetry driver #when it opts in toward a loopback sink #then every opt-out is cleared and the host is local", () => {
    const env = { ...withTelemetryOptOut({ PATH: "/bin", OMO_DISABLE_POSTHOG: "1" }), ...telemetryLocalSinkEnv("http://127.0.0.1:4318") }

    expect(disabled(env)).toBe(false)
    expect(env.POSTHOG_HOST).toBe("http://127.0.0.1:4318")
    for (const name of TELEMETRY_OPT_OUT_NAMES) expect(env[name]).toBe("")
  })

  test("#given a non-loopback sink #when a driver opts in #then it is refused", () => {
    expect(() => telemetryLocalSinkEnv("https://us.i.posthog.com")).toThrow("loopback")
  })
})

describe("QA drivers opt out of telemetry", () => {
  const files = qaSources().map((path) => ({ path, source: readFileSync(join(repoRoot, path), "utf8") }))

  test("#given every QA driver #when it can boot the runtime #then its child env is built by the shared helper", () => {
    expect(findUnroutedDrivers(files)).toEqual([])
  })

  test("#given the reviewed exceptions #when the tree is scanned #then each one still exists and still matches the scan", () => {
    const stale = Object.keys(NO_RUNTIME_SPAWN).filter((path) => {
      const file = files.find((entry) => entry.path === path)
      return file === undefined || !(SPAWN.test(file.source) && /process\.env/u.test(file.source) && RUNTIME.test(file.source))
    })
    expect(stale).toEqual([])
  })

  test("#given a new driver that launches senpi with the caller's env #when the scan runs #then it is rejected", () => {
    const driver = {
      path: "script/qa/new-driver.mjs",
      source: `import { spawn } from "node:child_process"\nspawn("senpi", ["-p"], { env: { ...process.env } })\n`,
    }
    expect(findUnroutedDrivers([...files, driver])).toEqual(["script/qa/new-driver.mjs"])
  })
})
