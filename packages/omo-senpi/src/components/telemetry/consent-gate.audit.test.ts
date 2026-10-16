import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

// Every telemetry write to disk or the network must sit behind the one consent gate,
// `isOmoNativeTelemetryEnabled` (#10226 H1). This scan pins each writer site in the component to a
// reviewed entry, so a new store write, file write, client, or capture call fails here until someone
// routes it through the gate and records why below.
const WRITER = /\b(?:writeFileSync|appendFileSync|mkdirSync|renameSync|openSync|writeFile|appendFile|mkdir|rename|fetch|createEventTelemetryClient|recordDailyActive|recordSenpiDailyActive|getDailyActiveCaptureState|captureEvent|capture)\s*\(/gu

type WriterCounts = Readonly<Record<string, number>>

const GATED_WRITERS: Readonly<Record<string, { readonly reason: string; readonly writers: WriterCounts }>> = {
  "index.ts": {
    reason: "legacy daily-active; the only registered caller is omo-native-session after the gate",
    writers: { recordSenpiDailyActive: 2, recordDailyActive: 1 },
  },
  "omo-native-category-config.ts": { reason: "called from the gated session_started path", writers: { captureEvent: 1 } },
  "omo-native-component.ts": {
    reason: "capture fan-in reaches a transport only after the gated session client exists; opted-out hashes are dropped",
    writers: { captureEvent: 1, capture: 3, createEventTelemetryClient: 1 },
  },
  "omo-native-computer-use.ts": { reason: "through the component fan-in", writers: { captureEvent: 3 } },
  "omo-native-crash.ts": { reason: "called from the gated session_started path", writers: { captureEvent: 1 } },
  "omo-native-delegation.ts": { reason: "through the component fan-in", writers: { capture: 2, captureEvent: 1 } },
  "omo-native-kibitzer-summary.ts": { reason: "through the component fan-in", writers: { captureEvent: 1 } },
  "omo-native-notice.ts": { reason: "marker written only after isOmoNativeTelemetryEnabled", writers: { mkdirSync: 1, writeFileSync: 1 } },
  "omo-native-parallel-summary.ts": { reason: "through the component fan-in", writers: { captureEvent: 1 } },
  "omo-native-prompt.ts": { reason: "through the component fan-in", writers: { captureEvent: 1 } },
  "omo-native-session-summary.ts": { reason: "recorder writes and sends only under isConsented", writers: { captureEvent: 1 } },
  "omo-native-session.ts": {
    reason: "the gate's owner: every writer runs after isOmoNativeTelemetryEnabled",
    writers: { createEventTelemetryClient: 1, getDailyActiveCaptureState: 1, captureEvent: 2, recordSenpiDailyActive: 1 },
  },
  "omo-native-tools.ts": { reason: "through the component fan-in", writers: { captureEvent: 3 } },
  "omo-native-turns.ts": { reason: "through the component fan-in", writers: { captureEvent: 1 } },
  "process-crash-records.ts": { reason: "claims run from the gated session_started path", writers: { mkdirSync: 1, openSync: 1 } },
  "product-identity.ts": {
    reason: "salt and install id are created only by a gated hash or attribution call",
    writers: { mkdirSync: 2, writeFileSync: 4 },
  },
  "session-summary-store.ts": { reason: "written only by the consent-checked recorder", writers: { mkdirSync: 1, writeFileSync: 1, renameSync: 2 } },
}

type SourceFile = { readonly name: string; readonly source: string }

export function findUngatedWriters(files: readonly SourceFile[]): readonly string[] {
  const violations: string[] = []
  for (const file of files) {
    const found: Record<string, number> = {}
    for (const match of file.source.matchAll(WRITER)) {
      const writer = match[0].replace(/\s*\($/u, "")
      found[writer] = (found[writer] ?? 0) + 1
    }
    const expected = GATED_WRITERS[file.name]?.writers ?? {}
    for (const writer of new Set([...Object.keys(found), ...Object.keys(expected)])) {
      if ((found[writer] ?? 0) !== (expected[writer] ?? 0)) {
        violations.push(`${file.name}: ${writer} x${found[writer] ?? 0} (reviewed x${expected[writer] ?? 0})`)
      }
    }
  }
  return violations
}

async function telemetrySources(): Promise<readonly SourceFile[]> {
  const names = (await readdir(import.meta.dir))
    .filter((name) => name.endsWith(".ts") && !name.includes(".test.") && !name.includes("test-support"))
    .sort()
  return Promise.all(names.map(async (name) => ({ name, source: await readFile(join(import.meta.dir, name), "utf8") })))
}

describe("telemetry consent gate audit", () => {
  test("#given the telemetry component sources #when writer sites are scanned #then each one is a reviewed, gated writer", async () => {
    expect(findUngatedWriters(await telemetrySources())).toEqual([])
  })

  test("#given a new file that writes to disk #when the audit scans it #then the unreviewed writer is rejected", async () => {
    const files = [...await telemetrySources(), {
      name: "omo-native-new-writer.ts",
      source: `import { writeFileSync } from "node:fs"\nexport function persist(path: string): void {\n  writeFileSync(path, "x")\n}\n`,
    }]
    expect(findUngatedWriters(files)).toEqual(["omo-native-new-writer.ts: writeFileSync x1 (reviewed x0)"])
  })

  test("#given an extra capture call in a reviewed file #when the audit scans it #then the count mismatch is rejected", async () => {
    const files = (await telemetrySources()).map((file) => file.name === "omo-native-turns.ts"
      ? { ...file, source: `${file.source}\nexport function leak(client: { captureEvent(name: string): void }): void {\n  client.captureEvent("turn_completed")\n}\n` }
      : file)
    expect(findUngatedWriters(files)).toEqual(["omo-native-turns.ts: captureEvent x2 (reviewed x1)"])
  })
})
