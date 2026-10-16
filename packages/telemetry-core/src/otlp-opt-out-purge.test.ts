import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { createOtlpTelemetryTransport } from "./otlp-sender"
import { createBatchId } from "./otlp-spool-dir"
import {
  capture,
  createSpoolRoot,
  decodeLogs,
  logRecordsOf,
  makeTransport,
  recordingFetch,
  spoolNames,
  TEST_SCOPE,
  testResource,
} from "./otlp-test-support"
import type { TelemetryDiagnosticInput } from "./types"

const roots: (() => void)[] = []
afterEach(() => {
  for (const cleanup of roots.splice(0)) cleanup()
})

function root(): string {
  const created = createSpoolRoot("telemetry-core-purge-")
  roots.push(created.cleanup)
  return created.dir
}

/** What earlier consented runs and other processes leave behind: every kind of spool entry. */
function seedSpool(dir: string): void {
  mkdirSync(join(dir, "quarantine"), { recursive: true })
  const now = Date.now()
  writeFileSync(join(dir, `batch-logs-${createBatchId(now)}.otlp`), "sealed")
  writeFileSync(join(dir, `batch-traces-${createBatchId(now)}.sending-${"a".repeat(32)}-${now + 60_000}`), "claimed")
  writeFileSync(join(dir, `active-logs-999-${"b".repeat(32)}.otlp`), "wal")
  writeFileSync(join(dir, "quarantine", `batch-logs-${createBatchId(now)}.otlp`), "corrupt")
}

function optOut(spoolDir: string, spoolRoot: string, diagnostics: TelemetryDiagnosticInput[]): void {
  const transport = createOtlpTelemetryTransport({
    productEnvPrefix: "OMO_TEST",
    ingestKey: "k",
    spoolDir,
    spoolRoot,
    resource: testResource(),
    scope: TEST_SCOPE,
    env: { DO_NOT_TRACK: "1" },
    diagnostics: (input) => diagnostics.push(input),
    autoStart: false,
  })
  expect(transport).toBeNull()
}

const refusals = (diagnostics: TelemetryDiagnosticInput[]): number =>
  diagnostics.filter((d) => d.event === "telemetry_spool_purge_refused").length

describe("the opt-out purge deletes only what the spool created, only inside a verified spool directory", () => {
  test("#given foreign files and a foreign subdirectory next to the spool's own files #when the purge runs #then only the spool's own files go and the foreign ones survive", () => {
    // given
    const dir = root()
    seedSpool(dir)
    writeFileSync(join(dir, "notes.txt"), "foreign")
    mkdirSync(join(dir, "projects", "keep"), { recursive: true })
    writeFileSync(join(dir, "projects", "keep", "batch-logs-not-ours.otlp"), "foreign")
    writeFileSync(join(dir, "quarantine", "readme.md"), "foreign")
    const diagnostics: TelemetryDiagnosticInput[] = []

    // when
    optOut(dir, dirname(dir), diagnostics)

    // then
    expect(spoolNames(dir)).toEqual(["notes.txt", "projects", "quarantine"])
    expect(readdirSync(join(dir, "quarantine"))).toEqual(["readme.md"])
    expect(readdirSync(join(dir, "projects", "keep"))).toEqual(["batch-logs-not-ours.otlp"])
    expect(refusals(diagnostics)).toBe(0)
  })

  test("#given the spool directory is a symlink #when the purge runs #then it is refused, counted, and the link target is untouched", () => {
    // given
    const base = root()
    const target = join(dirname(base), "elsewhere")
    seedSpool(target)
    const before = spoolNames(target)
    symlinkSync(target, base, "junction")
    const diagnostics: TelemetryDiagnosticInput[] = []

    // when
    optOut(base, dirname(base), diagnostics)

    // then
    expect(spoolNames(target)).toEqual(before)
    expect(readdirSync(join(target, "quarantine")).length).toBe(1)
    expect(refusals(diagnostics)).toBe(1)
  })

  test("#given a spool directory whose real path escapes the expected spool root #when the purge runs #then it is refused, counted, and nothing is deleted", () => {
    // given
    const base = root()
    const spoolRoot = join(dirname(base), "root")
    const outside = join(dirname(base), "outside")
    mkdirSync(spoolRoot, { recursive: true })
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, join(spoolRoot, "link"), "junction")
    const dir = join(spoolRoot, "link", "telemetry-spool")
    seedSpool(dir)
    const before = spoolNames(dir)
    const diagnostics: TelemetryDiagnosticInput[] = []

    // when
    optOut(dir, spoolRoot, diagnostics)

    // then
    expect(spoolNames(join(outside, "telemetry-spool"))).toEqual(before)
    expect(refusals(diagnostics)).toBe(1)
  })
})

describe("opt-out purges the spool", () => {
  for (const env of [{ DO_NOT_TRACK: "1" }, { OTEL_SDK_DISABLED: "true" }, { OMO_TEST_SEND_ANONYMOUS_TELEMETRY: "0" }]) {
    test(`#given a spool left by earlier runs #when the process starts opted out (${Object.keys(env)[0]}) #then every batch, claim, WAL and quarantined file is deleted`, () => {
      // given
      const dir = root()
      seedSpool(dir)

      // when
      const transport = createOtlpTelemetryTransport({
        productEnvPrefix: "OMO_TEST",
        ingestKey: "k",
        spoolDir: dir,
        resource: testResource(),
        scope: TEST_SCOPE,
        env,
        autoStart: false,
      })

      // then
      expect(transport).toBeNull()
      expect(existsSync(dir)).toBe(false)
    })
  }

  test("#given consent is withdrawn mid-run #when the transport flushes #then batches of other processes, claims, WAL and quarantine are deleted too", async () => {
    // given
    const dir = root()
    seedSpool(dir)
    let consent = true
    const { calls, fetch } = recordingFetch()
    const transport = makeTransport(dir, { consent: () => consent, fetch })
    capture(transport, "feature_used", { feature: "a" })
    consent = false

    // when
    await transport.flush()

    // then
    expect(calls.length).toBe(0)
    expect(spoolNames(dir)).toEqual([])
  })

  test("#given a second live process that still has consent #when the first one purges #then the second keeps working without throwing and delivers what it captures afterwards", async () => {
    // given
    const dir = root()
    let consentA = true
    const diagnostics: TelemetryDiagnosticInput[] = []
    const a = makeTransport(dir, { consent: () => consentA, pid: 11, bootId: "1".repeat(32) })
    const { calls, fetch } = recordingFetch()
    const b = makeTransport(dir, { fetch, pid: 12, bootId: "2".repeat(32), diagnostics: (input) => diagnostics.push(input) })
    capture(b, "feature_used", { feature: "before-purge" })
    consentA = false

    // when
    await a.flush()
    await b.flush()
    capture(b, "feature_used", { feature: "after-purge" })
    await b.flush()

    // then
    const features = calls.flatMap((c) => logRecordsOf(decodeLogs(c.body))).map((r) => r.attributes.find((kv) => kv.key === "omo.feature")?.value?.value)
    expect(features).toContainEqual({ case: "stringValue", value: "after-purge" })
    expect(diagnostics.filter((d) => d.event === "telemetry_spool_write_failed")).toEqual([])
    expect(spoolNames(dir)).toEqual([])
  })
})
