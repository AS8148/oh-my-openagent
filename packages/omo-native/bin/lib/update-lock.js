import { execFileSync } from "node:child_process"

// Bun reports a file Windows will not let it move or replace as EPERM/EBUSY (NtSetInformationFile),
// and some paths surface the same sharing violation as EACCES.
const LOCK_PATTERN = /\b(EPERM|EBUSY|EACCES)\b|NtSetInformationFile|being used by another process/i

/** Backoff between attempts while the file is held; the lock is usually a short antivirus scan. */
export const LOCK_RETRY_DELAYS_MS = [2000, 5000]

/** @param {string | undefined} stderr */
export function isLockFailure(stderr) {
  return typeof stderr === "string" && LOCK_PATTERN.test(stderr)
}

/**
 * The quoted package or path Bun names on the failing line (or the line before it), if any.
 * @param {string | undefined} stderr
 */
export function heldTarget(stderr) {
  if (typeof stderr !== "string") return undefined
  const lines = stderr.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!LOCK_PATTERN.test(lines[index])) continue
    for (const line of [lines[index], lines[index - 1] ?? ""]) {
      const quoted = /"([^"]+)"|'([^']+)'/.exec(line)
      if (quoted) return quoted[1] ?? quoted[2]
    }
  }
  return undefined
}

/**
 * @typedef {{ pid: number, name: string, commandLine?: string | null, executablePath?: string | null }} ProcessEntry
 */

function normalizePath(path) {
  return path.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase()
}

/**
 * Processes running from, or started with a path inside, the install directory, minus this update's own
 * processes. Only those can hold a file of the install; anything else (an antivirus scan) is invisible here.
 * @param {string} installDir
 * @param {readonly ProcessEntry[]} processes
 * @param {readonly number[]} excludePids
 */
export function findHolders(installDir, processes, excludePids) {
  const needle = `${normalizePath(installDir)}\\`
  return processes.filter((entry) => {
    if (excludePids.includes(entry.pid)) return false
    return [entry.executablePath, entry.commandLine].some((value) => typeof value === "string" && normalizePath(value).includes(needle))
  })
}

/**
 * Every process on this Windows machine with its path and command line, through CIM. Fail-open: a host
 * where the query cannot run reports no holders rather than failing the update report.
 * @returns {ProcessEntry[]}
 */
export function listWindowsProcesses() {
  try {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    )
    const parsed = JSON.parse(output)
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return rows.map((row) => ({
      pid: Number(row.ProcessId),
      name: String(row.Name ?? ""),
      executablePath: row.ExecutablePath ?? null,
      commandLine: row.CommandLine ?? null,
    }))
  } catch {
    return []
  }
}
