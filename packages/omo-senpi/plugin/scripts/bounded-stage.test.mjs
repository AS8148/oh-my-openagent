import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"

import { npmCliPath, npmPackStage, runBoundedStage } from "./bounded-stage.test-support.mjs"

// Stand-in for a packaging stage that stalls, with a child of its own like a shell-launched tool (#10911).
const STALLED_WITH_CHILD = [
  "const { spawn } = require('node:child_process')",
  "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
  "console.log(`CHILD ${child.pid}`)",
  "setInterval(() => {}, 1000)",
].join("\n")

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("runBoundedStage (#10911)", () => {
  test("#given a stage that finishes #when it runs #then its status and output are returned", async () => {
    const result = await runBoundedStage("echo", process.execPath, ["-e", "console.log('done')"], {}, 20_000)
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe("done")
  })

  test.skipIf(process.platform !== "win32")("#given a stage that stalls with a child #when its cap passes #then it fails naming the stage and its child is gone too", async () => {
    const failure = await runBoundedStage("stalled stage", process.execPath, ["-e", STALLED_WITH_CHILD], {}, 2_000).catch((error) => error)
    expect(String(failure?.message)).toContain("stalled stage did not finish within 2000 ms")
    const childPid = Number(String(failure?.message).match(/CHILD (\d+)/)?.[1])
    expect(Number.isSafeInteger(childPid)).toBe(true)
    expect(alive(childPid)).toBe(false)
  }, 30_000)

  test.skipIf(process.platform === "win32")("#given a stage that stalls #when its cap passes #then it fails naming the stage with its output", async () => {
    const failure = await runBoundedStage("stalled stage", process.execPath, ["-e", "console.log('started'); setInterval(() => {}, 1000)"], {}, 2_000).catch((error) => error)
    expect(String(failure?.message)).toContain("stalled stage did not finish within 2000 ms")
    expect(String(failure?.message)).toContain("started")
  }, 30_000)
})

function isInside(parent, child) {
  const path = relative(parent, child)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

describe("npmCliPath (#10911)", () => {
  test("#given npm on a POSIX PATH linked to npm-cli.js #when it is resolved #then the JavaScript entry is returned", () => {
    const files = new Set(["/b/npm"])
    const cli = npmCliPath({
      platform: "linux",
      pathValue: "/a:/b",
      isFile: (path) => files.has(path),
      realpath: (path) => path === "/b/npm" ? "/opt/node/lib/node_modules/npm/bin/npm-cli.js" : path,
    })
    expect(cli).toBe("/opt/node/lib/node_modules/npm/bin/npm-cli.js")
  })

  test("#given npm.cmd on a Windows Path #when it is resolved #then the npm-cli.js beside it is returned, not the cmd shim", () => {
    const files = new Set(["C:\\node\\npm.cmd", "C:\\node\\node_modules\\npm\\bin\\npm-cli.js"])
    const cli = npmCliPath({ platform: "win32", pathValue: "C:\\tools;C:\\node", isFile: (path) => files.has(path), realpath: (path) => path })
    expect(cli).toBe("C:\\node\\node_modules\\npm\\bin\\npm-cli.js")
  })

  test("#given an npm that is not a JavaScript file, or no npm #when it is resolved #then it fails naming what it found", () => {
    expect(() => npmCliPath({ platform: "linux", pathValue: "/shim", isFile: (path) => path === "/shim/npm", realpath: (path) => path }))
      .toThrow("/shim/npm")
    expect(() => npmCliPath({ platform: "linux", pathValue: "/empty", isFile: () => false, realpath: (path) => path }))
      .toThrow("no npm on PATH")
  })
})

describe("npmPackStage (#10911)", () => {
  test("#given a package in a scratch dir #when the npm pack stage is built #then npm's JavaScript runs under node --single-threaded, with no shell, outside the scratch dir", () => {
    const work = join(tmpdir(), "omo-sync-sidecar-pack-spec")
    const pkg = join(work, "pkg")
    const stage = npmPackStage(pkg, work, { npmCli: "/opt/node/lib/node_modules/npm/bin/npm-cli.js" })
    expect(stage.command).toBe("node")
    expect(stage.args.slice(0, 2)).toEqual(["--single-threaded", "/opt/node/lib/node_modules/npm/bin/npm-cli.js"])
    expect(stage.args.slice(2)).toEqual(["pack", pkg, "--silent", "--pack-destination", work])
    expect(stage.options.shell).toBeFalsy()
    expect(isInside(work, stage.options.cwd)).toBe(false)
  })

  test("#given the npm pack stage #when it runs a stand-in npm that ends with process.exit #then that node ran single-threaded outside the scratch dir", async () => {
    const work = await mkdtemp(join(tmpdir(), "omo-npm-pack-stage-"))
    try {
      const cli = join(work, "npm-cli.js")
      await writeFile(cli, "console.log(JSON.stringify({ execArgv: process.execArgv, cwd: process.cwd() })); process.exit(0)\n")
      const stage = npmPackStage(join(work, "pkg"), work, { npmCli: cli })
      const result = await runBoundedStage("npm pack", stage.command, stage.args, stage.options, 20_000)
      expect(result.status, result.stderr).toBe(0)
      const seen = JSON.parse(result.stdout.trim())
      expect(seen.execArgv).toContain("--single-threaded")
      expect(isInside(work, seen.cwd)).toBe(false)
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }, 30_000)
})
