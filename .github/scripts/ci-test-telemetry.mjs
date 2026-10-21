import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { cpus, freemem, totalmem } from "node:os"
import { basename, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export function descendants(processes, rootPid) {
  const ids = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of processes) {
      if (ids.has(row.parentPid) && !ids.has(row.pid)) {
        ids.add(row.pid)
        changed = true
      }
    }
  }
  return processes.filter((row) => ids.has(row.pid))
}

export function instrumentArguments(args, configPath, timingsPath, workers) {
  let configured = false
  const result = args.map((arg) => {
    if (arg.startsWith("--config=")) {
      configured = true
      return `--config=${configPath}`
    }
    return arg === "--parallel" ? `--parallel=${workers}` : arg
  })
  const testIndex = result.indexOf("test")
  if (testIndex < 0) throw new Error("expected a Bun test invocation")
  // With the existing panic wrapper, config belongs to its inner Bun command.
  if (!configured) result.splice(testIndex, 0, `--config=${configPath}`)
  result.push(`--timings=${timingsPath}`, "--update-timings")
  return result
}

function cpuCounters() {
  const times = cpus().map((cpu) => cpu.times)
  return {
    idle: times.reduce((sum, time) => sum + time.idle, 0),
    total: times.reduce((sum, time) => sum + Object.values(time).reduce((a, b) => a + b, 0), 0),
  }
}

async function processes() {
  const command = process.platform === "win32"
    ? ["pwsh", "-NoProfile", "-File", fileURLToPath(new URL("./ci-test-processes.ps1", import.meta.url))]
    : ["ps", "-axo", "pid=,ppid=,lstart=,%cpu=,rss=,comm="]
  const probe = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", env: { ...process.env, LC_ALL: "C" } })
  const deadline = setTimeout(() => probe.kill(), 7000)
  try {
    const [output, , code] = await Promise.all([
      new Response(probe.stdout).text(), new Response(probe.stderr).text(), probe.exited,
    ])
    if (code !== 0) throw new Error("process-probe-failed")
    if (process.platform === "win32") return JSON.parse(output)
    return output.trim().split("\n").map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line)
      if (!match) throw new Error("process-probe-format")
      return {
        pid: Number(match[1]), parentPid: Number(match[2]),
        creationTimeUtc: new Date(match[3]).toISOString(),
        name: basename(match[6]), cpuPercent: Number(match[4]), rssBytes: Number(match[5]) * 1024,
      }
    })
  } finally {
    clearTimeout(deadline)
  }
}

export async function runTelemetry(directory, invocation, args, workers = "4") {
  if (!/^[a-z0-9-]+$/.test(invocation) || !["2", "4"].includes(workers)) {
    throw new Error("expected safe invocation and 2 or 4 workers")
  }
  directory = resolve(directory)
  mkdirSync(directory, { recursive: true })
  const prefix = resolve(directory, invocation)
  const configArgument = args.find((arg) => arg.startsWith("--config="))
  const originalPath = resolve(configArgument?.slice("--config=".length) ?? "bunfig.toml")
  const original = readFileSync(originalPath, "utf8")
  const preloads = Bun.TOML.parse(original).test.preload
  const preloadScript = fileURLToPath(new URL("./ci-test-preload.mjs", import.meta.url))
  const configPath = resolve(`.ci-telemetry-${invocation}-${process.pid}.toml`)
  const preloadOutput = `${prefix}-preload.jsonl`
  const timingsPath = `${prefix}-files.json`
  // No history is read: collecting timings must not rebalance the measured run.
  rmSync(timingsPath, { force: true })
  writeFileSync(preloadOutput, "")
  writeFileSync(configPath, original.replace(
    /^preload\s*=\s*\[[^\]]*\]/m,
    `preload = [${JSON.stringify(preloadScript.replaceAll("\\", "/"))}]`,
  ))
  const started = performance.now()
  const samples = []
  const errors = []
  function capture(stage, action) {
    try {
      return action()
    } catch (error) {
      errors.push({ stage, type: error.name })
      console.warn(`[ci-profile] ${stage} capture failed: ${error.name}`)
      return null
    }
  }
  let previous = cpuCounters()
  let child
  let timer
  let sampling
  let finished = false
  let exitCode = 1
  let observedWorkers = null
  const seen = new Map()
  async function sample() {
    try {
      const table = await processes()
      const tree = descendants(table, child.pid)
      for (const row of tree) seen.set(`${row.pid}:${row.creationTimeUtc}`, row)
      const current = cpuCounters()
      const delta = current.total - previous.total
      const record = {
        elapsedMs: performance.now() - started,
        cpuPercent: delta > 0 ? 100 * (1 - (current.idle - previous.idle) / delta) : null,
        availableMemoryBytes: freemem(),
        treeRssBytes: tree.reduce((sum, row) => sum + row.rssBytes, 0),
        childProcessCount: tree.filter((row) => row.pid !== child.pid).length,
        processes: tree,
      }
      previous = current
      samples.push(record)
      appendFileSync(`${prefix}-samples.jsonl`, `${JSON.stringify(record)}\n`)
    } catch (error) {
      errors.push({ stage: "sample", type: error.name })
    }
    if (!finished) timer = setTimeout(() => { sampling = sample() }, 2000)
  }
  async function pump(stream, sink) {
    const decoder = new TextDecoder()
    let pending = ""
    for await (const chunk of stream) {
      sink.write(chunk)
      pending += decoder.decode(chunk, { stream: true })
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ""
      for (const line of lines) {
        const match = /bun test v.*?\b(\d+)x PARALLEL/.exec(line)
        if (match) observedWorkers = Number(match[1])
        if (line.includes("[ci-profile] preload capture failed:")) {
          errors.push({ stage: "preload", type: "write-failed" })
        }
      }
    }
  }
  try {
    child = Bun.spawn([process.execPath, ...instrumentArguments(args, configPath, timingsPath, workers)], {
      stdin: "inherit", stdout: "pipe", stderr: "pipe",
      env: {
        ...process.env,
        CI_TEST_PRELOAD_OUTPUT: preloadOutput,
        CI_TEST_PRELOAD_MODULES: JSON.stringify(preloads.map((name) => ({
          name, url: pathToFileURL(resolve(name)).href,
        }))),
      },
    })
    sampling = sample()
    const forward = () => child.kill()
    process.once("SIGTERM", forward)
    process.once("SIGINT", forward)
    try {
      const result = await Promise.all([
        child.exited, pump(child.stdout, process.stdout), pump(child.stderr, process.stderr),
      ])
      exitCode = result[0]
    } finally {
      process.removeListener("SIGTERM", forward)
      process.removeListener("SIGINT", forward)
    }
  } finally {
    finished = true
    clearTimeout(timer)
    await sampling
    rmSync(configPath, { force: true })
    const files = existsSync(timingsPath)
      ? capture("file-timings", () => JSON.parse(readFileSync(timingsPath, "utf8")).files) : null
    const preloads = capture("preload", () => readFileSync(preloadOutput, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)) ?? []
    const payload = {
      schemaVersion: 1, sha: process.env.CI_TEST_SHA ?? process.env.GITHUB_SHA ?? null,
      runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      shard: process.env.WINDOWS_TEST_SHARD ?? null, invocation,
      configuredWorkers: args.includes("--parallel") ? Number(workers) : 1,
      observedWorkers, availableCpus: cpus().length, totalMemoryBytes: totalmem(),
      durationMs: performance.now() - started, exitCode, files,
      preloadEvaluations: preloads.length,
      preloadTotalMs: preloads.reduce((sum, row) => sum + row.durationMs, 0),
      peakChildProcesses: Math.max(0, ...samples.map((row) => row.childProcessCount)),
      peakTreeRssBytes: Math.max(0, ...samples.map((row) => row.treeRssBytes)),
      peakCpuPercent: samples.length ? Math.max(...samples.map((row) => row.cpuPercent ?? 0)) : null,
      minimumAvailableMemoryBytes: samples.length ? Math.min(...samples.map((row) => row.availableMemoryBytes)) : null,
      sampleCount: samples.length, processInventory: [...seen.values()], errors,
    }
    capture("profile", () => writeFileSync(`${prefix}-profile.json`, `${JSON.stringify(payload, null, 2)}\n`))
    if (process.env.GITHUB_STEP_SUMMARY) {
      const slowest = Object.entries(files ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 10)
      capture("summary", () => appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
        `\n### Shard profile: ${invocation}`,
        `SHA: \`${payload.sha}\`; workers configured/observed: ${payload.configuredWorkers}/${observedWorkers ?? "not reported"}; CPUs: ${payload.availableCpus}.`,
        `Exit: ${exitCode}; wall: ${payload.durationMs.toFixed(0)} ms; samples: ${samples.length}; capture errors: ${errors.length}.`,
        `Peak descendants: ${payload.peakChildProcesses}; peak tree RSS: ${payload.peakTreeRssBytes} bytes.`,
        `Peak host CPU: ${payload.peakCpuPercent ?? "unavailable"}%; minimum available memory: ${payload.minimumAvailableMemoryBytes ?? "unavailable"} bytes.`,
        `Preload imports: ${preloads.length}; summed evaluation time: ${payload.preloadTotalMs.toFixed(0)} ms (overlaps across workers).`,
        `Runner per-file timings: ${files === null ? "missing (incomplete/crashed run)" : `${Object.keys(files).length} files`}.`,
        "| Slowest file (runner wall time) | ms |", "| --- | ---: |",
        ...slowest.map(([name, ms]) => `| \`${name.replaceAll("|", "\\|")}\` | ${ms} |`),
        "\nCPU/available-memory time series and creation-qualified process inventory are in the artifact; sampling can miss short-lived children.\n",
      ].join("\n")))
    }
  }
  return exitCode
}

if (import.meta.main) {
  const [directory, invocation, workers, ...args] = process.argv.slice(2)
  process.exitCode = await runTelemetry(directory, invocation, args, workers)
}
