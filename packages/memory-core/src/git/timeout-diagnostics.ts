import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// Opt-in evidence for a git that outlives its timeout (omo #10821): on Windows CI one `git add` stalls
// past 30 s and its repository stays locked long after the kill, and no run has reproduced it on
// demand. When this variable names a directory, the timeout records the live process table (with
// the stalled git's thread wait states on Windows) before git is signalled. Unset, nothing runs.
export const GIT_TIMEOUT_DIAGNOSTICS_ENV = "OMO_GIT_TIMEOUT_DIAGNOSTICS_DIR"

const SNAPSHOT_TIMEOUT_MS = 15_000

function processSnapshot(pid: number): string {
  const command = process.platform === "win32"
    ? spawnSync("powershell", ["-NoProfile", "-Command", [
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate,CommandLine | Format-Table -AutoSize -Wrap | Out-String -Width 400",
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Threads | Group-Object ThreadState,WaitReason -NoElement | Format-Table -AutoSize | Out-String`,
    ].join("; ")], { encoding: "utf8", timeout: SNAPSHOT_TIMEOUT_MS, windowsHide: true })
    : spawnSync("ps", ["-axo", "pid,ppid,stat,wchan,etime,command"], { encoding: "utf8", timeout: SNAPSHOT_TIMEOUT_MS })
  if (command.error) return `process snapshot failed: ${command.error.message}`
  return `${command.stdout}${command.stderr}`
}

export function recordGitTimeout(environment: NodeJS.ProcessEnv, pid: number | undefined, argv: readonly string[], cwd: string, timeoutMs: number): void {
  const directory = environment[GIT_TIMEOUT_DIAGNOSTICS_ENV]
  if (!directory || pid === undefined) return
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, `git-timeout-${pid}-${Date.now()}.json`), `${JSON.stringify({
      at: new Date().toISOString(),
      pid,
      cwd,
      timeoutMs,
      argv: argv.slice(0, 12),
      argCount: argv.length,
      processes: processSnapshot(pid),
    }, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`git timeout diagnostics could not be written to ${directory}: ${String(error)}\n`)
  }
}
