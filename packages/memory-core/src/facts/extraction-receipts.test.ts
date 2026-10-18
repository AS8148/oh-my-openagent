import { afterEach, describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { GitMemoryRepo } from "../git"
import { renderClaimReceipt } from "../provenance"
import { buildDefaultSeedFiles } from "../seeds"
import { applyFactsBatch, FactsExtractionValidationError, parseFactsExtractionRecord } from "./extraction"
import { removeTree } from "../../../../test-support/remove-tree"

const AUTHOR = { agentId: "facts-agent", authorName: "Facts Extractor" }
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => removeTree(dir, { maxRetries: 10, retryDelay: 200 })))
})

async function repo(): Promise<GitMemoryRepo> {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), "memory-facts-receipts-")))
  tempDirs.push(dir)
  const memory = new GitMemoryRepo({ dir, agentId: AUTHOR.agentId })
  await memory.init({ seedFiles: buildDefaultSeedFiles() })
  return memory
}

describe("facts claim receipts", () => {
  test("#given facts with receipts #when applied #then each bullet carries its receipt and a receipt-less legacy record renders unchanged (#10488)", async () => {
    // given
    const memory = await repo()
    const downgraded = { source: "agent", downgraded: true } as const
    const user = { source: "user", userQuote: "keep plugin X" } as const

    // when
    await applyFactsBatch(memory, {
      batchId: "4b0f6f0e-6a55-4a43-9a8c-2f0d5f7d3c11",
      records: [
        { scope: "project", text: "User agreed to remove plugins X and Y.", date: "2026-10-18", receipt: downgraded },
        { scope: "project", text: "User keeps plugin X.", date: "2026-10-18", receipt: user },
        { scope: "project", text: "Legacy fact.", date: "2026-10-18" },
      ],
    }, AUTHOR)

    // then
    const note = await readFile(join(memory.dir, "notes/facts/2026-10.md"), "utf8")
    expect(note).toContain(`- [2026-10-18] User agreed to remove plugins X and Y. (source: ${renderClaimReceipt(downgraded)})`)
    expect(note).toContain(`- [2026-10-18] User keeps plugin X. (source: ${renderClaimReceipt(user)})`)
    expect(note).toContain("- [2026-10-18] Legacy fact.\n")
  }, 30_000)

  test("#given a malformed receipt #when parsed #then the record is rejected", () => {
    const record = { scope: "project", text: "fact", date: "2026-10-18" } as const
    expect(() => parseFactsExtractionRecord({ ...record, receipt: { source: "boss" } }, 0)).toThrow(FactsExtractionValidationError)
    expect(() => parseFactsExtractionRecord({ ...record, receipt: { source: "user" } }, 0)).toThrow(FactsExtractionValidationError)
    expect(parseFactsExtractionRecord({ ...record, receipt: { source: "agent", downgraded: true } }, 0))
      .toEqual({ ...record, receipt: { source: "agent", downgraded: true } })
  })
})
