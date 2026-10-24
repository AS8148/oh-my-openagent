import { describe, expect, test } from "bun:test"
import { runChild } from "../bin/lib/child-process.js"
import { runSelfUpdate } from "../bin/lib/self-update.js"

// #10090: on Windows `bun add -g` dies with EPERM (NtSetInformationFile) when another process holds
// a file of the install it is replacing. omo update retries the lock, names the holder when it stays
// held, and leaves the previous install in place.

const INSTALL_DIR = String.raw`C:\Users\u\.bun\install\global\node_modules`
const HELD_STDERR = [
  'error: moving "@anthropic-ai/claude-agent-sdk-win32-x64" to cache dir failed',
  "EPERM: Operation not permitted (NtSetInformationFile())",
].join("\n")

const bunUpdate = (targetVersion?: string) => ({
  manager: "bun",
  command: `bun add -g omo-ai@${targetVersion ?? "latest"}`,
  argv: ["bun", "add", "-g", `omo-ai@${targetVersion ?? "latest"}`],
})

type Outcome = { status: number; stderr?: string }

function harness(options: {
  outcomes: Outcome[]
  platform?: NodeJS.Platform
  versions?: string[]
  processes?: Array<{ pid: number; name: string; commandLine?: string; executablePath?: string }>
}) {
  const spawned: string[][] = []
  const sleeps: number[] = []
  const lines: string[] = []
  const errors: string[] = []
  const versions = options.versions ?? ["5.1.1", "5.1.1", "5.1.1"]
  let reads = 0
  let runs = 0
  return {
    spawned,
    sleeps,
    lines,
    errors,
    options: {
      platform: options.platform ?? "win32",
      installDir: INSTALL_DIR,
      selfPids: [100, 101],
      resolveUpdate: bunUpdate,
      fetchDistTags: () => ({ latest: "5.1.2" }),
      env: {},
      readInstalled: () => {
        const omo = versions[Math.min(reads, versions.length - 1)]
        reads += 1
        if (omo === "unreadable") throw new Error("package.json missing")
        return { omo, engine: "2026.10.1" }
      },
      run: async (command: string, args: string[]) => {
        spawned.push([command, ...args])
        const outcome = options.outcomes[Math.min(runs, options.outcomes.length - 1)]
        runs += 1
        return { status: outcome.status, signal: null, stderr: outcome.stderr ?? "" }
      },
      sleep: async (ms: number) => {
        sleeps.push(ms)
      },
      listProcesses: () => options.processes ?? [],
      log: (line: string) => lines.push(line),
      error: (line: string) => errors.push(line),
    },
  }
}

describe("omo update on Windows when a package file is held (#10090)", () => {
  describe("#given the lock clears before the retries run out", () => {
    test("#then it retries with backoff and finishes the update", async () => {
      const h = harness({
        outcomes: [{ status: 1, stderr: HELD_STDERR }, { status: 0 }],
        versions: ["5.1.1", "5.1.2"],
      })
      expect(await runSelfUpdate([], h.options)).toBe(0)
      expect(h.spawned).toHaveLength(2)
      expect(h.sleeps).toEqual([2000])
      expect(h.lines.some((line) => line.includes("@anthropic-ai/claude-agent-sdk-win32-x64") && line.includes("retrying"))).toBe(true)
      expect(h.lines.at(-1)).toBe("omo 5.1.1 -> 5.1.2 (engine: senpi 2026.10.1)")
    })
  })

  describe("#given the file stays held by a process of this install", () => {
    test("#then it stops after three attempts and names the file, the holder and one action", async () => {
      const h = harness({
        outcomes: [{ status: 1, stderr: HELD_STDERR }],
        processes: [
          { pid: 100, name: "node.exe", commandLine: `node ${INSTALL_DIR}\\omo-ai\\bin\\omo.js update` },
          { pid: 4242, name: "claude.exe", executablePath: `${INSTALL_DIR.toLowerCase()}\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe` },
          { pid: 777, name: "explorer.exe", executablePath: String.raw`C:\Windows\explorer.exe` },
        ],
      })
      expect(await runSelfUpdate([], h.options)).toBe(1)
      expect(h.spawned).toHaveLength(3)
      expect(h.sleeps).toEqual([2000, 5000])
      const text = h.errors.join("\n")
      expect(text).toContain("@anthropic-ai/claude-agent-sdk-win32-x64")
      expect(text).toContain("claude.exe (pid 4242)")
      expect(text).not.toContain("pid 100")
      expect(text).not.toContain("explorer.exe")
      expect(text).toContain("Quit claude.exe and run omo update again.")
      expect(text).toContain("omo 5.1.1 is still installed.")
    })
  })

  describe("#given no process of this install holds the file", () => {
    test("#then the action names the scanner case instead of a process", async () => {
      const h = harness({ outcomes: [{ status: 1, stderr: HELD_STDERR }] })
      expect(await runSelfUpdate([], h.options)).toBe(1)
      const text = h.errors.join("\n")
      expect(text).toContain("No omo process holds it")
      expect(text).toContain("wait a minute and run omo update again")
    })
  })

  describe("#given the failed install left a different or unreadable omo", () => {
    test("#then it reinstalls the previous version once and says whether that worked", async () => {
      const h = harness({
        outcomes: [{ status: 1, stderr: HELD_STDERR }, { status: 1, stderr: HELD_STDERR }, { status: 1, stderr: HELD_STDERR }, { status: 0 }],
        versions: ["5.1.1", "unreadable", "5.1.1"],
      })
      expect(await runSelfUpdate([], h.options)).toBe(1)
      expect(h.spawned.at(-1)).toEqual(["bun", "add", "-g", "omo-ai@5.1.1"])
      expect(h.errors.join("\n")).toContain("restored omo 5.1.1")
    })
  })

  describe("#given the same EPERM text on a POSIX host", () => {
    test("#then it is a plain failure with no retry", async () => {
      const h = harness({ outcomes: [{ status: 1, stderr: HELD_STDERR }], platform: "linux" })
      expect(await runSelfUpdate([], h.options)).toBe(1)
      expect(h.spawned).toHaveLength(1)
      expect(h.sleeps).toEqual([])
    })
  })

  describe("#given a Windows failure that is not a lock", () => {
    test("#then it fails once with the retry command", async () => {
      const h = harness({ outcomes: [{ status: 1, stderr: "error: GET https://registry.npmjs.org/omo-ai - 404" }] })
      expect(await runSelfUpdate([], h.options)).toBe(1)
      expect(h.spawned).toHaveLength(1)
      expect(h.errors).toEqual(["omo: update failed; retry with: bun add -g omo-ai@5.1.2"])
    })
  })
})

describe("runChild captureStderr", () => {
  test("#then the child's stderr is returned while the exit status is kept", async () => {
    const result = await runChild(process.execPath, ["-e", "process.stderr.write('held'); process.exit(3)"], {
      captureStderr: true,
      stdio: "inherit",
    })
    expect(result.status).toBe(3)
    expect(result.stderr).toBe("held")
  })
})
