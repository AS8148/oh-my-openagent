import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { batchCreatedMs, createBatchId, oldestSealedBatches } from "./otlp-spool-dir"
import { createSpoolRoot } from "./otlp-test-support"

const roots: (() => void)[] = []
afterEach(() => {
  for (const cleanup of roots.splice(0)) cleanup()
})

describe("batch ids", () => {
  test("#given 1,000 ids created in the same millisecond #then sorting them reproduces creation order", () => {
    // given
    const ms = 1_760_000_000_000

    // when
    const ids = Array.from({ length: 1_000 }, () => createBatchId(ms))

    // then
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(1_000)
    expect(ids.every((id) => batchCreatedMs(id) === ms)).toBe(true)
  })

  test("#given sealed batches whose ids share one millisecond #then they are listed for sending in seal order", () => {
    // given
    const created = createSpoolRoot("telemetry-core-batch-id-")
    roots.push(created.cleanup)
    mkdirSync(created.dir, { recursive: true })
    const ms = 1_760_000_000_000
    const ids = Array.from({ length: 50 }, () => createBatchId(ms))
    for (const [index, id] of ids.entries()) {
      writeFileSync(join(created.dir, `batch-${index % 2 === 0 ? "logs" : "traces"}-${id}.otlp`), "")
    }

    // when
    const listed = oldestSealedBatches(created.dir).map((entry) => entry.batchId)

    // then
    expect(listed).toEqual(ids)
  })

  test("#given an older timestamp after a newer one #then the id keeps its own creation time", () => {
    // given
    createBatchId(1_760_000_000_000)

    // when
    const old = createBatchId(1_700_000_000_000)

    // then
    expect(batchCreatedMs(old)).toBe(1_700_000_000_000)
  })
})
