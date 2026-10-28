import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const PRELOAD = join(import.meta.dir, "test-support", "hermetic-home.preload.ts")

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// The planted processes name the child run's hermetic home on their command line, exactly as a task host's
// socket argument would, but no task host registration in that home's agent dir names them: they stand for
// a process of another run, or a test's own child, that the teardown must never signal (#11630).
const PLANTING_TEST = `import { test } from "bun:test"
import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"

function plant(script: string, name: string): number {
  // The inner shell is backgrounded by an outer one that exits at once, so it is not this process's child.
  const out = spawnSync("/bin/sh", ["-c", '/bin/sh -c "$1" "$2" </dev/null >/dev/null 2>&1 & echo $!', "plant", script, \`\${process.env.HOME}/\${name}\`], { encoding: "utf8" })
  return Number.parseInt(out.stdout.trim(), 10)
}

test("plants processes that name this run's hermetic home", () => {
  const pids = [
    plant("while :; do sleep 1; done", "foreign-process"),
    plant("trap '' TERM; while :; do sleep 1; done", "term-ignoring-process"),
  ]
  writeFileSync(process.env.PLANTED_PIDS_FILE as string, JSON.stringify(pids))
})
`

describe("hermetic-home teardown signals only the task hosts this run started (#11630)", () => {
  let dir = ""
  let planted: number[] = []
  let run: { readonly code: number | null; readonly output: string; readonly elapsedMs: number } | undefined

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "omo-hermetic-teardown-"))
    const cwd = join(dir, "run")
    mkdirSync(cwd)
    writeFileSync(join(cwd, "planting.test.ts"), PLANTING_TEST)
    const pidsFile = join(dir, "planted.json")
    const started = Date.now()
    // A 5 s hook budget is Bun's default for every file after the first: a teardown that waits out a
    // process it signalled, or scans the whole process table under load, overruns it as an unnamed hook failure.
    const child = spawn(process.execPath, ["test", "--timeout", "5000", "--preload", PRELOAD, "./planting.test.ts"], {
      cwd,
      env: { ...process.env, PLANTED_PIDS_FILE: pidsFile },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString() })
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString() })
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve))
    run = { code, output, elapsedMs: Date.now() - started }
    planted = JSON.parse(readFileSync(pidsFile, "utf8")) as number[]
  }, 60_000)

  afterAll(() => {
    for (const pid of planted) {
      if (alive(pid)) process.kill(pid, "SIGKILL")
    }
    rmSync(dir, { recursive: true, force: true })
  })

  test("#given a process that names the run's home but is no task host of the run #when the run ends #then it is not signalled", () => {
    expect(planted).toHaveLength(2)
    expect(planted.map(alive)).toEqual([true, true])
  })

  test("#given a process that ignores SIGTERM #when the run ends #then the teardown is not held past the hook budget", () => {
    expect(run?.output ?? "").not.toContain("hook timed out")
    expect({ code: run?.code, output: run?.output }).toEqual({ code: 0, output: run?.output })
  })
})
