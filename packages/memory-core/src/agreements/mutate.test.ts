import { describe, expect, test } from "bun:test"

import { agreementId } from "./format"
import { applyAgreementRecords } from "./mutate"
import type { AgreementItem, AgreementsPolicy } from "./types"

const POLICY: AgreementsPolicy = { needsHumanThreshold: 3, maxItems: 64 }

function item(text: string, overrides: Partial<AgreementItem> = {}): AgreementItem {
  return { id: agreementId(text), scope: "global", by: "agent", text, n: 1, since: "2026-10-01", last: "2026-10-01", status: "active", ...overrides }
}

describe("applyAgreementRecords: counting and the needs-human threshold", () => {
  test("#given an item corrected twice #when the third correction is reaffirmed #then n is 3 and it flips to needs-human exactly once", () => {
    // given
    const monitor = item("Never filter the message monitor output", { n: 2 })

    // when
    const third = applyAgreementRecords([monitor], [{ action: "reaffirm", id: monitor.id, date: "2026-10-21" }], POLICY)
    const fourth = applyAgreementRecords(third.items, [{ action: "reaffirm", id: monitor.id, date: "2026-10-22" }], POLICY)

    // then
    expect(third.items).toEqual([{ ...monitor, n: 3, last: "2026-10-21", status: "needs-human" }])
    expect(third.newlyFlagged).toEqual([monitor.id])
    expect(fourth.items[0]?.n).toBe(4)
    expect(fourth.newlyFlagged).toEqual([])
  })

  test("#given a correction the extractor reports as new #when its text matches an existing item #then the existing item is counted instead of duplicated", () => {
    // given
    const monitor = item("Never filter the message monitor output", { n: 1 })

    // when
    const result = applyAgreementRecords(
      [monitor],
      [{ action: "new", applies: "global", text: "never filter the message monitor output!", date: "2026-10-21" }],
      POLICY,
    )

    // then
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.n).toBe(2)
  })

  test("#given an agent item #when reaffirmed with stronger wording #then the text changes but the id and count history stay", () => {
    // given
    const tests = item("Run tests before claiming done", { n: 1 })

    // when
    const result = applyAgreementRecords(
      [tests],
      [{ action: "reaffirm", id: tests.id, date: "2026-10-21", text: "Always run the full test suite before claiming done" }],
      POLICY,
    )

    // then
    expect(result.items[0]).toMatchObject({ id: tests.id, n: 2, text: "Always run the full test suite before claiming done" })
  })
})

describe("applyAgreementRecords: human-written items are immutable to automation", () => {
  test("#given a human item #when automation reaffirms it with new wording and a cap merge runs #then its text and scope are untouched, it is counted, and it is never merged or evicted", () => {
    // given
    const human = item("Never filter the message monitor", { by: "human", n: 2 })
    const overlapping = item("Never filter the message monitor output stream", { n: 1, since: "2026-10-02" })
    const policy: AgreementsPolicy = { needsHumanThreshold: 3, maxItems: 2 }

    // when
    const result = applyAgreementRecords(
      [human, overlapping],
      [
        { action: "reaffirm", id: human.id, date: "2026-10-21", text: "Do whatever with the monitor" },
        { action: "new", applies: "global", text: "Never filter the monitor output", date: "2026-10-21" },
      ],
      policy,
    )

    // then
    const kept = result.items.find((entry) => entry.id === human.id)
    expect(kept).toEqual({ ...human, n: 3, last: "2026-10-21", status: "needs-human" })
    expect(result.items.filter((entry) => entry.by === "agent")).toHaveLength(1)
    expect(result.items).toHaveLength(2)
  })
})

describe("applyAgreementRecords: the cap", () => {
  test("#given a full ledger of unrelated items #when a new unrelated agreement arrives #then it is refused and the ledger keeps its size", () => {
    // given
    const full = [item("Use bun, never npm"), item("Answer in Korean in the chat room")]

    // when
    const result = applyAgreementRecords(
      full,
      [{ action: "new", applies: "project", text: "Keep run roots out of tmp", date: "2026-10-21" }],
      { needsHumanThreshold: 3, maxItems: 2 },
    )

    // then
    expect(result.items).toHaveLength(2)
    expect(result.refusedOverCap).toEqual(["Keep run roots out of tmp"])
  })
})
