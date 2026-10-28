import { spawn, spawnSync } from "node:child_process"
import { realpathSync, statSync } from "node:fs"
import { join, parse, posix, win32 } from "node:path"
import { windowsTreeKillArgs } from "../../../memory-core/src/concurrency/windows-process-tree.mjs"

// One external stage of a packaging test, run without blocking the test process (#10911): it either
// settles with its output or, past `capMs`, has its whole process tree killed and awaited, and fails
// naming the stage. A `spawnSync` stage that stalls gives no clue which step hung, and a shell-launched
// child of a killed `cmd.exe` keeps files open so the scratch directory cannot be removed.
export function runBoundedStage(stage, command, args, options, capMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, windowsHide: true })
    let stdout = ""
    let stderr = ""
    child.stdout?.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
    child.stderr?.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
    let stalled = false
    const cap = setTimeout(() => {
      stalled = true
      if (process.platform === "win32" && child.pid !== undefined) {
        const args = windowsTreeKillArgs(child.pid)
        if (args.length > 0) spawnSync("taskkill", args, { windowsHide: true })
      } else {
        child.kill("SIGKILL")
      }
      // A process outside the killed tree may still hold the pipes; without them `close` can still fire.
      child.stdout?.destroy()
      child.stderr?.destroy()
    }, capMs)
    child.once("error", (error) => {
      clearTimeout(cap)
      reject(new Error(`${stage} could not start: ${error.message}`))
    })
    child.once("close", (status) => {
      clearTimeout(cap)
      if (stalled) {
        reject(new Error(`${stage} did not finish within ${capMs} ms; stdout: ${stdout.slice(-500)} stderr: ${stderr.slice(-500)}`))
        return
      }
      resolve({ status, stdout, stderr })
    })
  })
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

// The JavaScript entry of the npm on PATH: on Windows the npm-cli.js beside the first npm.cmd, elsewhere the real
// path of the first npm, which an npm installed with Node links to npm-cli.js.
export function npmCliPath({ platform = process.platform, pathValue = process.env.PATH ?? process.env.Path ?? "", isFile: exists = isFile, realpath = realpathSync } = {}) {
  const path = platform === "win32" ? win32 : posix
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    if (platform === "win32") {
      if (!exists(path.join(dir, "npm.cmd"))) continue
      const cli = path.join(dir, "node_modules", "npm", "bin", "npm-cli.js")
      if (exists(cli)) return cli
      throw new Error(`npm.cmd in ${dir} has no node_modules\\npm\\bin\\npm-cli.js beside it`)
    }
    const npm = path.join(dir, "npm")
    if (!exists(npm)) continue
    const cli = realpath(npm)
    if (/\.[cm]?js$/.test(cli)) return cli
    throw new Error(`${npm} is not npm's JavaScript entry (it resolves to ${cli})`)
  }
  throw new Error("no npm on PATH")
}

// npm 11 ends every command with process.exit(). On Node 24 that call joins V8's platform workers while one can be
// parked waiting for a GC that only the main thread runs, so npm can hang after printing its result
// (nodejs/node#64274, fix pending in nodejs/node#66171): the npm pack stall of #10911. --single-threaded turns V8's
// background tasks off; NODE_OPTIONS refuses it, so npm's JavaScript entry runs under node directly. Started that
// way npm pack is one process, not cmd.exe -> npm.cmd -> node, so the stage's tree kill always reaches it, and it
// runs from the filesystem root: Windows cannot remove a directory that is a live process's current directory.
export function npmPackStage(pkg, destination, { npmCli = npmCliPath(), cwd = parse(process.cwd()).root } = {}) {
  return {
    command: "node",
    args: ["--single-threaded", npmCli, "pack", pkg, "--silent", "--pack-destination", destination],
    options: { cwd },
  }
}

// The Windows `tar`, independent of PATH: under Git Bash's PATH `tar` is GNU tar, which reads `C:\...`
// as a remote host and fails.
export function systemTar() {
  return process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar"
}
