import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Privacy promise (lead, 2026-10-20): with telemetry off, the OTLP entry loads no OpenTelemetry, protobuf or
// sender code and writes nothing. A child process records every TypeScript module it loads through a Bun
// onLoad hook; the enabled run is the positive control that the hook sees the sender when it does load.

const ENTRY = join(import.meta.dir, "otlp-entry.ts")
const HEAVY = /\/(otlp-sender|otel-providers|otel-minimal-(logs|trace)|otlp-wal|otlp-spool-(dir|file|cap)|otlp-encode|otlp-http|otlp-batch-sender)\.ts$|\/otlp-proto\//

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function loadedModules(env: Record<string, string>, consent: boolean): Promise<{ readonly loaded: readonly string[]; readonly result: string; readonly spool: boolean }> {
  const root = mkdtempSync(join(tmpdir(), "telemetry-core-entry-spy-"))
  roots.push(root)
  const out = join(root, "loaded.json")
  writeFileSync(join(root, "spy.ts"), [
    'import { readFileSync, writeFileSync } from "node:fs"',
    "const seen: string[] = []",
    'Bun.plugin({ name: "load-spy", setup(build) { build.onLoad({ filter: /\\.ts$/ }, (args) => { seen.push(args.path); return { contents: readFileSync(args.path, "utf8"), loader: "ts" } }) } })',
    `process.on("exit", () => writeFileSync(${JSON.stringify(out)}, JSON.stringify(seen)))`,
  ].join("\n"))
  writeFileSync(join(root, "probe.ts"), [
    `const { createOtlpTelemetryTransport } = await import(${JSON.stringify(ENTRY)})`,
    `const transport = await createOtlpTelemetryTransport({ productEnvPrefix: "OMO_TEST", ingestKey: "k", spoolDir: ${JSON.stringify(join(root, "spool"))}, spoolRoot: ${JSON.stringify(root)}, resource: {}, scope: { name: "omo-senpi", version: "1" }, project: () => ({}), spans: {}, env: ${JSON.stringify(env)}, consent: () => ${consent}, autoStart: false })`,
    'console.log(transport === null ? "RESULT null" : "RESULT transport")',
    "await transport?.shutdown()",
  ].join("\n"))
  const child = Bun.spawn([process.execPath, "--preload", join(root, "spy.ts"), join(root, "probe.ts")], { stdout: "pipe", stderr: "pipe" })
  const timeout = setTimeout(() => child.kill(), 20_000)
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
  clearTimeout(timeout)
  expect(exitCode).toBe(0)
  const loaded: string[] = JSON.parse(await Bun.file(out).text())
  return { loaded, result: stdout.trim(), spool: existsSync(join(root, "spool")) }
}

describe("the OTLP entry loads nothing while telemetry is off", () => {
  const disabled: readonly (readonly [string, Record<string, string>, boolean])[] = [
    ["DO_NOT_TRACK=1", { DO_NOT_TRACK: "1" }, true],
    ["OTEL_SDK_DISABLED=true", { OTEL_SDK_DISABLED: "true" }, true],
    ["the product opt-out", { OMO_TEST_SEND_ANONYMOUS_TELEMETRY: "0" }, true],
    ["first run before consent (consent() false)", {}, false],
  ]
  for (const [label, env, consent] of disabled) {
    test(`#given ${label} #when a transport is requested #then null comes back, no OTLP module loaded and no spool exists`, async () => {
      const run = await loadedModules(env, consent)
      expect(run.result).toBe("RESULT null")
      expect(run.loaded.filter((path) => HEAVY.test(path))).toEqual([])
      expect(run.spool).toBe(false)
    }, 30_000)
  }

  test("#given telemetry on and consented #when a transport is requested #then the sender loads (the spy sees it)", async () => {
    const run = await loadedModules({}, true)
    expect(run.result).toBe("RESULT transport")
    expect(run.loaded.some((path) => path.endsWith("/otlp-sender.ts"))).toBe(true)
  }, 30_000)
})
