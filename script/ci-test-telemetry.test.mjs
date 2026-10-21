import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { descendants, instrumentArguments } from "../.github/scripts/ci-test-telemetry.mjs"

test("diagnostics preserve serial and existing crash-wrapper arguments", () => {
  expect(instrumentArguments(["test", "--timeout", "30000", "one.test.ts"], "config", "files", "2"))
    .toEqual(["--config=config", "test", "--timeout", "30000", "one.test.ts", "--timings=files", "--update-timings"])
  expect(instrumentArguments([
    "script/bun-panic-retry.ts", "--config=original", "test", "--parallel", "rpc-host",
  ], "config", "files", "2")).toEqual([
    "script/bun-panic-retry.ts", "--config=config", "test", "--parallel=2", "rpc-host",
    "--timings=files", "--update-timings",
  ])
})

test("process inventory includes nested children, not unrelated processes", () => {
  const rows = [
    { pid: 10, parentPid: 1, creationTimeUtc: "root" },
    { pid: 12, parentPid: 11, creationTimeUtc: "grandchild" },
    { pid: 11, parentPid: 10, creationTimeUtc: "child" },
    { pid: 13, parentPid: 1, creationTimeUtc: "unrelated" },
  ]
  expect(descendants(rows, 10)).toEqual(rows.slice(0, 3))
})

for (const workers of ["4", "2"]) {
  test(`real collector records native file/preload/resource data with ${workers} workers and preserves failures`, async () => {
    const root = mkdtempSync(join(tmpdir(), "ci-profile-"))
    const collector = new URL("../.github/scripts/ci-test-telemetry.mjs", import.meta.url).pathname
    const summary = join(root, "summary.md")
    try {
      writeFileSync(join(root, "bunfig.toml"), '[test]\npreload = ["./setup.mjs"]\n')
      writeFileSync(join(root, "setup.mjs"), 'globalThis.profileSetup = "loaded"\n')
      writeFileSync(join(root, "pass.test.ts"), 'import {expect, test} from "bun:test"; test("pass", () => expect(globalThis.profileSetup).toBe("loaded"))\n')
      writeFileSync(join(root, "fail.test.ts"), 'import {expect, test} from "bun:test"; test("fail", () => expect(1).toBe(2))\n')
      for (const [invocation, file, expectedExit] of [
        ["passed", "./pass.test.ts", 0], ["failed", "./fail.test.ts", 1],
      ]) {
        const child = Bun.spawn([
          process.execPath, collector, join(root, "artifacts"), invocation, workers,
          "test", "--parallel", file,
        ], {
          cwd: root, stdout: "pipe", stderr: "pipe",
          env: { ...process.env, GITHUB_STEP_SUMMARY: summary, CI_TEST_SHA: "diagnostic-sha" },
        })
        const [code, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ])
        expect(code, stdout + stderr).toBe(expectedExit)
        const prefix = join(root, "artifacts", invocation)
        const profile = JSON.parse(readFileSync(`${prefix}-profile.json`, "utf8"))
        expect(profile.exitCode).toBe(expectedExit)
        expect(profile.sha).toBe("diagnostic-sha")
        expect(profile.configuredWorkers).toBe(Number(workers))
        expect(profile.sampleCount).toBeGreaterThan(0)
        expect(profile.errors).toEqual([])
        expect(profile.totalMemoryBytes).toBeGreaterThan(0)
        expect(profile.availableCpus).toBeGreaterThan(0)
        expect(profile.preloadEvaluations).toBeGreaterThan(0)
        expect(Object.keys(profile.files).some((path) => path.endsWith(file.slice(2)))).toBe(true)
        const samples = readFileSync(`${prefix}-samples.jsonl`, "utf8").trim().split("\n").map(JSON.parse)
        expect(samples.every((sample) => sample.availableMemoryBytes > 0)).toBe(true)
        expect(samples.every((sample) => sample.childProcessCount >= 0)).toBe(true)
        expect(samples.flatMap((sample) => sample.processes).every((row) => row.creationTimeUtc)).toBe(true)
        const preload = readFileSync(`${prefix}-preload.jsonl`, "utf8").trim().split("\n").map(JSON.parse)
        expect(preload.every((row) => row.module === "./setup.mjs" && row.durationMs >= 0)).toBe(true)
      }
      expect(readFileSync(summary, "utf8")).toContain("diagnostic-sha")
      expect(readdirSync(root).some((name) => name.startsWith(".ci-telemetry-"))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 20000)
}
