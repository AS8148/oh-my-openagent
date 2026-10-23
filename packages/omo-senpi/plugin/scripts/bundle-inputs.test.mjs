import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import * as bundleInputs from "./bundle-inputs.mjs"

const { BUNDLE_INPUTS_PATH, mapFromTrace, renderBundleInputs } = bundleInputs
const repoRoot = join(import.meta.dir, "..", "..", "..", "..")
const tracer = join(import.meta.dir, "bundle-inputs-trace.mjs")

// Runs one script under the trace preload in a scratch dir and returns the trace rows.
const traceScript = (runtime, files, entry) => {
  const dir = mkdtempSync(join(tmpdir(), "omo-bundle-inputs-test-"))
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, name, ".."), { recursive: true })
      writeFileSync(join(dir, name), text)
    }
    const log = join(dir, "trace.jsonl")
    const preload = runtime === "bun" ? ["--preload", tracer] : [`--import=${pathToFileURL(tracer).href}`]
    const target = typeof entry === "string" ? [join(dir, entry)] : ["-e", entry.eval(dir)]
    const result = spawnSync(runtime, [...preload, ...target], { cwd: dir, env: { ...process.env, OMO_BUNDLE_INPUTS_TRACE: log, OMO_BUNDLE_INPUTS_TMP: dir }, encoding: "utf8" })
    if (result.status !== 0) throw new Error(`${runtime} exited ${result.status}: ${result.stderr}`)
    const rows = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []
    return { rows }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const root = "/repo"
const existing = new Set([
  "/repo/package.json",
  "/repo/bun.lock",
  "/repo/packages/memory-core/package.json",
  "/repo/packages/memory-core/tsconfig.json",
  "/repo/packages/omo-senpi/package.json",
])
const deps = { repoRoot: root, exists: (path) => existing.has(path), realpath: (path) => path }
const row = (kind, path) => ({ kind, path })

describe("mapFromTrace", () => {
  test("keeps every traced repo file and adds the manifests that steer resolution", () => {
    const map = mapFromTrace([row("bundle", "/repo/packages/memory-core/src/a.ts"), row("read", "/repo/packages/omo-senpi/plugin/scripts/build-artifact.mjs")], deps)
    expect(map.files).toEqual([
      "package.json",
      "packages/memory-core/package.json",
      "packages/memory-core/src/a.ts",
      "packages/memory-core/tsconfig.json",
      "packages/omo-senpi/package.json",
      "packages/omo-senpi/plugin/scripts/build-artifact.mjs",
    ])
  })

  test("collapses dependency files to the lockfile and drops paths outside the repo", () => {
    const map = mapFromTrace([row("bundle", "/repo/node_modules/zod/v4/index.js"), row("read", "/tmp/omo-senpi-check/omo.js"), row("read", "/repo/.git/HEAD")], deps)
    expect(map.files).toEqual(["bun.lock", "package.json"])
  })

  test("records listed directories separately, so any file added under them counts", () => {
    const map = mapFromTrace([row("list", "/repo/packages/omo-codex/src/install"), row("list", "/elsewhere")], deps)
    expect(map.directories).toEqual(["packages/omo-codex/src/install"])
  })

  test("never lists the map itself as an input", () => {
    const map = mapFromTrace([row("read", join(root, BUNDLE_INPUTS_PATH))], deps)
    expect(map.files).not.toContain(BUNDLE_INPUTS_PATH)
  })

  test("a step whose bundler metafile went missing fails the trace instead of under-reporting", () => {
    expect(() => mapFromTrace([row("missing-metafile", "/repo/x.json")], deps)).toThrow("metafile")
  })

  test("a module load the runtime could not trace fails the trace instead of under-reporting", () => {
    expect(() => mapFromTrace([row("missing-module-hooks", "/repo/a.ts -> ./b.ts")], deps)).toThrow("module hooks")
  })
})

// The --check legs of build:omo-native (OMO_SENPI_PLUGIN_OUTPUT=<buildRoot>/plugin) and a developer shell must
// not steer the traced generators at a staged copy outside the repo: those reads would drop out of the map.
describe("the recipe environment", () => {
  const scripts = readdirSync(import.meta.dir).filter((name) => name.endsWith(".mjs") && !name.includes(".test"))
  const knobs = new Set(scripts.flatMap((name) => readFileSync(join(import.meta.dir, name), "utf8").match(/\bOMO_[A-Z0-9_]*(?:OUTPUT|TARGET|ENTRY|DIST)\b/g) ?? []))

  test("drops every output-steering knob the recipe scripts read", () => {
    const scratch = "/scratch"
    const base = Object.fromEntries([...knobs, "OMO_SENPI_STAGE_FAIL_AFTER_BACKUP"].map((key) => [key, "/elsewhere/plugin"]))
    const env = bundleInputs.recipeEnv(scratch, { ...base, PATH: "/bin" })
    expect(bundleInputs.SCRUBBED_ENV).toContain("OMO_SENPI_PLUGIN_OUTPUT")
    for (const key of bundleInputs.SCRUBBED_ENV) expect(env[key]).toBeUndefined()
    for (const key of knobs) expect(env[key] === undefined || env[key].startsWith(scratch)).toBe(true)
    expect(env.PATH).toBe("/bin")
    expect(env.OMO_BUNDLE_INPUTS_TRACE).toBe(join(scratch, "trace.jsonl"))
  })
})

describe("the trace preload", () => {
  test("records a recursive cp source as a listed directory", () => {
    const { rows } = traceScript("node", {
      "src/a.txt": "a",
      "main.mjs": `import { cpSync } from "node:fs"\ncpSync(new URL("./src", import.meta.url), new URL("./out", import.meta.url), { recursive: true })\n`,
    }, "main.mjs")
    const src = rows.filter((r) => r.path.endsWith("/src"))
    expect(src.map((r) => r.kind)).toEqual(["list"])
  })

  test("under bun, which has no module hooks, a module importing another module fails the trace", () => {
    const { rows } = traceScript("bun", {
      "dep.mjs": "export const x = 1\n",
      "lib.mjs": `import { x } from "./dep.mjs"\nexport const y = x\n`,
      "main.mjs": `import { y } from "./lib.mjs"\nif (y !== 1) process.exit(1)\n`,
    }, "main.mjs")
    expect(rows.some((r) => r.kind === "missing-module-hooks")).toBe(true)
  })

  // The Codex step's shape: `bun -e` importing the generator, which imports builtins only.
  test("under bun -e, the entry's own import is recorded as a module, not a failure", () => {
    const { rows } = traceScript("bun", {
      "gen.mjs": `import { readFile } from "node:fs/promises"\nexport const run = () => readFile(new URL(import.meta.url))\n`,
    }, { eval: (dir) => `const m = await import(${JSON.stringify(pathToFileURL(join(dir, "gen.mjs")).href)}); await m.run()` })
    expect(rows.filter((r) => r.kind === "missing-module-hooks")).toEqual([])
    expect(rows.some((r) => r.kind === "module" && r.path.endsWith("/gen.mjs"))).toBe(true)
  })

  test("under bun, a step that imports only builtins traces cleanly", () => {
    const { rows } = traceScript("bun", { "main.mjs": `import { readFile } from "node:fs/promises"\nawait readFile(new URL(import.meta.url))\n` }, "main.mjs")
    expect(rows.filter((r) => r.kind === "missing-module-hooks")).toEqual([])
    expect(rows.some((r) => r.kind === "read" && r.path.endsWith("main.mjs"))).toBe(true)
  })
})

// The Codex step runs under bun, where module loads and named node:fs sync imports are not traced.
// The map is complete only while the Codex script imports builtins alone and reads through fs/promises.
describe("script/build-codex-install.ts", () => {
  const source = readFileSync(join(repoRoot, "script", "build-codex-install.ts"), "utf8")
  const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm)].map((m) => m[1])

  test("imports builtins only, so the bun trace sees every file it reads", () => {
    expect(imports.length).toBeGreaterThan(0)
    const builtins = new Set(builtinModules)
    expect(imports.filter((s) => !(s.startsWith("node:") || builtins.has(s)))).toEqual([])
    expect(imports).not.toContain("node:fs")
    expect(imports).not.toContain("fs")
  })
})

describe("the committed map", () => {
  const committed = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "..", BUNDLE_INPUTS_PATH), "utf8"))

  test("is rendered in canonical form", () => {
    expect(readFileSync(join(import.meta.dir, "..", "..", "..", "..", BUNDLE_INPUTS_PATH), "utf8")).toBe(renderBundleInputs(committed))
  })

  // The bundle marker hashes the build scripts next to the sources (build-artifact.mjs digestBuildSources),
  // so a comment-only edit to either changes every header: both must be inputs.
  test("covers the files every bundle header hashes", () => {
    for (const path of [
      "packages/omo-senpi/plugin/scripts/build-artifact.mjs",
      "packages/omo-senpi/plugin/scripts/build-extension-core.mjs",
      "packages/omo-senpi/src/extension/bundled-index.ts",
      "packages/omo-senpi/src/install/cli-local.ts",
      "script/build-codex-install.ts",
    ]) expect(committed.files).toContain(path)
  })
})
