// Probe branch only. Instrument exact checked-out source, not a synthetic replacement fixture.
import { readFileSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"

const root = resolve(process.argv[2])
const prefix = "packages/omo-native/"
function edit(relative, before, after) {
  const path = join(root, prefix, relative)
  const source = readFileSync(path, "utf8")
  if (source.split(before).length !== 2) throw new Error(`Expected exactly one instrumentation boundary: ${relative}: ${before}`)
  writeFileSync(path, source.replace(before, () => after))
}
const mark = (step, fields = "") => `console.error("PROVIDER_PROFILE", JSON.stringify({ step: "${step}", at: Date.now()${fields ? `, ${fields}` : ""} }));`
edit("bin/lib/package-paths.js", "indexPath = resolveIndex()", `
    const profileStarted = Date.now()
    ${mark("engine-resolve-start")}
    indexPath = resolveIndex()
    ${mark("engine-resolve-end", 'elapsedMs: Date.now() - profileStarted, installCache: indexPath.replaceAll("\\\\", "/").includes("/.bun/install/cache/")')}
`)
edit("bin/lib/setup-opencode-providers.js",
  "const catalog = readOpencodeCatalog(home, env, ids.some((id) => !ownEndpoint(id)) ? notices : [])",
  `const profileStarted = Date.now()
  const catalog = readOpencodeCatalog(home, env, ids.some((id) => !ownEndpoint(id)) ? notices : [])
  ${mark("catalog-cache-read", "elapsedMs: Date.now() - profileStarted, found: catalog !== undefined")}`)
edit("bin/lib/setup-import.js", "const home = options.home ?? homedir()", `
  const profileStarted = Date.now()
  ${mark("setup-start")}
  const home = options.home ?? homedir()`)
edit("bin/lib/setup-import.js",
  "write(setupStages(plans).filter((stage) => stage.present && (applied.has(stage.id) || stage.plan.pending === 0)).flatMap((stage) => stage.counts(stage.plan)))",
  `write(setupStages(plans).filter((stage) => stage.present && (applied.has(stage.id) || stage.plan.pending === 0)).flatMap((stage) => stage.counts(stage.plan)))
  ${mark("setup-finished", "elapsedMs: Date.now() - profileStarted")}`)
edit("test/setup-opencode-providers.test.ts", "function fixture(): Fixture {", `function fixture(): Fixture {
  const profileStarted = Date.now()`)
edit("test/setup-opencode-providers.test.ts", 'write(join(app, "package.json"), JSON.stringify({ name: "omo-ai", version: "test", type: "module" }))',
  `write(join(app, "package.json"), JSON.stringify({ name: "omo-ai", version: "test", type: "module" }))
  ${mark("fixture-ready", 'elapsedMs: Date.now() - profileStarted, nodeModules: existsSync(join(app, "node_modules"))')}`)
const testPath = join(root, prefix, "test/setup-opencode-providers.test.ts")
let testSource = readFileSync(testPath, "utf8")
if (testSource.includes("async function run(")) {
  edit("test/setup-opencode-providers.test.ts", "async function run(", "async function unprofiledRun(")
} else {
  edit("test/setup-opencode-providers.test.ts", "function run(", "function unprofiledRun(")
  // Bound the intentionally stalled baseline CHILD, not its uninterruptible synchronous parent.
  edit("test/setup-opencode-providers.test.ts",
    'const result = spawnSync(process.execPath, [item.launcher, ...args], { encoding: "utf8", env: childEnv(item) })',
    'const result = spawnSync(process.execPath, [item.launcher, ...args], { encoding: "utf8", env: childEnv(item), ...(process.env.PROFILE_HELD_REGISTRY === "1" ? { timeout: 20_000 } : {}) })')
}
edit("test/setup-opencode-providers.test.ts", "function readJson(", `
function run(item: Fixture, args: string[]): any {
  const started = Date.now()
  ${mark("child-spawn", "args")}
  const done = (result: any) => {
    ${mark("child-exit", 'elapsedMs: Date.now() - started, status: result.status, bunCache: existsSync(join(item.home, ".bun")), tempEntries: readdirSync(item.tmp).length, engineWarning: result.stdout.includes("could not read the engine"), modelCarried: existsSync(join(item.agentDir, "settings.json")) && readJson(join(item.agentDir, "settings.json")).defaultModel === "kimi-k2.5"')}
    console.error(result.stderr)
    return result
  }
  try {
    const result = unprofiledRun(item, args)
    return result instanceof Promise ? result.then(done) : done(result)
  } catch (error) {
    ${mark("child-failed", "elapsedMs: Date.now() - started")}
    throw error
  }
}
function readJson(`)

const selection = "its key stored and the default model carried"
async function attempt(mode, number, registry) {
  const started = Date.now()
  console.log("PROFILE_ATTEMPT", JSON.stringify({ variant: process.env.PROFILE_VARIANT, head: process.env.PROFILE_HEAD, mode, number, at: started }))
  const child = Bun.spawn([process.execPath, "test", `${prefix}test/setup-opencode-providers.test.ts`, "-t", selection, "--timeout", "120000"], {
    cwd: root,
    env: {
      ...process.env,
      PROFILE_HELD_REGISTRY: mode === "held" ? "1" : "0",
      ...(registry ? { BUN_CONFIG_DEFAULT_REGISTRY: registry, npm_config_registry: registry } : {}),
    },
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await child.exited
  console.log("PROFILE_RESULT", JSON.stringify({ variant: process.env.PROFILE_VARIANT, head: process.env.PROFILE_HEAD, mode, number, code, elapsedMs: Date.now() - started }))
  return code
}
for (let i = 1; i <= 3; i++) await attempt("normal", i)
let requests = 0
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  fetch(request) {
    requests++
    console.log("HELD_REGISTRY_REQUEST", JSON.stringify({ at: Date.now(), path: new URL(request.url).pathname }))
    return new Promise(() => {})
  },
})
try {
  await attempt("held", 1, server.url.href)
  console.log("HELD_REGISTRY_TOTAL", requests)
} finally {
  server.stop(true)
}
