import { describe, expect, it } from "bun:test"
import { rankRecallDocumentsBm25 } from "./bm25"
import type { RecallDocument } from "./provider"

function doc(path: string, body: string): RecallDocument {
  return { path, description: path, body }
}

function ranking(documents: readonly RecallDocument[], query: string): string[] {
  return rankRecallDocumentsBm25(documents, [query]).map(({ document, score }) => `${document.path}:${score}`)
}

describe("recall bm25 index storage", () => {
  it("#given a HEAD move that replaces one note #when ranked again #then the replaced note is ranked by its new body", () => {
    // given
    const kept = doc("kept.md", "deploy rollback checklist")
    const before = doc("changed.md", "lunch menu")
    expect(ranking([kept, before], "lighthouse")).toEqual([])

    // when
    const after = doc("changed.md", "lighthouse deploy rollback")
    const ranked = ranking([kept, after], "lighthouse")

    // then
    expect(ranked).toHaveLength(1)
    expect(ranked[0]).toStartWith("changed.md:")
  })

  it("#given the term dictionary outgrew the live vocabulary #when a smaller corpus is ranked #then scores match the ones before", () => {
    // given
    const small = [doc("a.md", "release blocker heap retainer"), doc("b.md", "heap snapshot retainer path")]
    const expected = ranking(small, "heap retainer")
    const wide = doc("wide.md", Array.from({ length: 70_000 }, (_, index) => `zq${index.toString(36)}`).join(" "))
    expect(ranking([...small, wide], "zq0")).toHaveLength(1)

    // when
    const afterCompaction = ranking([...small], "heap retainer")

    // then
    expect(afterCompaction).toEqual(expected)
    expect(ranking([...small, wide], "heap retainer")).toHaveLength(2)
  })
})
