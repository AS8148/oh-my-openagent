/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test"

import { classifyClaims } from "./classify"
import { answer, editResult, evalRun, failingTest, type FixtureEntry, passingTest, userInput } from "./entries.test-support"
import { buildTimeline } from "./evidence"
import { matchClaims } from "./match"

function verdictFor(before: readonly FixtureEntry[], text: string, after: readonly FixtureEntry[] = []) {
  const entries = [userInput("fix it"), ...before, answer(text), ...after]
  const answerAt = before.length + 1
  const [verdict] = matchClaims(buildTimeline(entries), classifyClaims(text), answerAt)
  return verdict
}

describe("claim-receipt matcher", () => {
  describe("#given the four receipt orderings", () => {
    it("#then a claim before any check is unsupported", () => {
      expect(verdictFor([...editResult("e1", "src/a.ts")], "All tests pass.")).toMatchObject({ status: "unsupported", reason: "no-check" })
    })

    it("#then a claim after a failed check is unsupported", () => {
      expect(verdictFor([...editResult("e1", "src/a.ts"), ...failingTest("t1")], "All tests pass.")).toMatchObject({
        status: "unsupported",
        reason: "last-check-failed",
      })
    })

    it("#then a claim after a passing check is supported with that receipt", () => {
      const verdict = verdictFor([...editResult("e1", "src/a.ts"), ...passingTest("t1")], "All tests pass.")
      expect(verdict).toMatchObject({ status: "supported", receipt: { kind: "test", outcome: "passed" } })
    })

    it("#then an edit after a passing check makes the claim stale", () => {
      const verdict = verdictFor([...passingTest("t1"), ...editResult("e1", "src/a.ts")], "All tests pass.")
      expect(verdict).toMatchObject({ status: "unsupported", reason: "stale-after-edit", invalidatedBy: { paths: ["src/a.ts"] } })
    })
  })

  describe("#given checks that disagree over time", () => {
    it("#then a later failure outweighs an earlier pass", () => {
      expect(verdictFor([...passingTest("t1"), ...failingTest("t2")], "All tests pass.")).toMatchObject({ reason: "last-check-failed" })
    })

    it("#then a pass after the claim cannot erase the failure visible when it was made", () => {
      expect(verdictFor([...failingTest("t1")], "All tests pass.", [...passingTest("t2")])).toMatchObject({
        status: "unsupported",
        reason: "last-check-failed",
      })
    })

    it("#then a notes-only edit after a pass keeps the claim supported", () => {
      expect(verdictFor([...passingTest("t1"), ...editResult("e1", "notes/RESULT.md")], "All tests pass.")).toMatchObject({ status: "supported" })
    })

    it("#then an unknown latest check is not flagged", () => {
      const unknown = evalRun("t2", { code: "await sh(`bun test`)", output: "running" })
      expect(verdictFor([...failingTest("t1"), ...unknown], "All tests pass.")).toMatchObject({ status: "unknown" })
    })
  })

  describe("#given the kind of claim", () => {
    const typecheckOnly = evalRun("k1", { code: "await sh(`tsgo --noEmit`)", output: "TYPECHECK_EXIT=0" })

    it("#then a claim whose kind of check never ran here is unknown, while a done claim accepts any check", () => {
      expect(verdictFor([...editResult("e1", "src/a.ts"), ...typecheckOnly], "All tests pass.")).toMatchObject({ status: "unknown" })
      expect(verdictFor([...editResult("e1", "src/a.ts"), ...typecheckOnly], "Done.")).toMatchObject({ status: "supported" })
    })

    it("#then a done claim with no code edit is not a code-completion claim", () => {
      expect(verdictFor([], "조사 완료했습니다.")).toMatchObject({ status: "unknown" })
    })

    it("#then a concrete result report with no recognised check is unknown, but a visible contradiction still flags it", () => {
      expect(verdictFor([...editResult("e1", "src/a.ts")], "The rerun exited 0 with 343 passing.")).toMatchObject({ status: "unknown" })
      expect(verdictFor([...editResult("e1", "src/a.ts"), ...failingTest("t1")], "The rerun exited 0 with 343 passing.")).toMatchObject({
        status: "unsupported",
        reason: "last-check-failed",
      })
    })

    it("#then an admitted claim is recorded as admitted, never unsupported", () => {
      expect(verdictFor([...editResult("e1", "src/a.ts")], "I have not run the tests; they should pass.")).toMatchObject({ status: "admitted" })
    })
  })
})
