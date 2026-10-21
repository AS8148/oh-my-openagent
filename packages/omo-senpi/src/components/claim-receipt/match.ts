import type { Claim, ClaimKind } from "./classify"
import type { CheckEvidence, CheckKind, CheckOutcome, EditEvidence, Timeline } from "./evidence"

export type ClaimStatus = "supported" | "unsupported" | "unknown" | "admitted"
export type UnsupportedReason = "no-check" | "last-check-failed" | "stale-after-edit"

export interface ClaimVerdict {
  readonly claim: Claim
  readonly status: ClaimStatus
  readonly reason?: UnsupportedReason
  readonly receipt?: { readonly entryId: string; readonly kind: CheckKind; readonly outcome: CheckOutcome }
  readonly invalidatedBy?: { readonly entryId: string; readonly paths: readonly string[] }
}

const ANY_CHECK: ReadonlySet<CheckKind> = new Set(["test", "typecheck", "lint", "build", "run", "lsp"])
const SUPPORTED_BY: Readonly<Record<ClaimKind, ReadonlySet<CheckKind>>> = {
  test: new Set(["test"]),
  typecheck: new Set(["typecheck", "lsp"]),
  lint: new Set(["lint"]),
  build: new Set(["build"]),
  run: new Set(["run", "test", "build"]),
  exists: ANY_CHECK,
  done: ANY_CHECK,
}

const receiptOf = (check: CheckEvidence) => ({ entryId: check.entryId, kind: check.kind, outcome: check.outcome })
const latest = <T extends { readonly at: number }>(items: readonly T[]): T | undefined =>
  items.reduce<T | undefined>((best, item) => (best === undefined || item.at >= best.at ? item : best), undefined)

function judge(claim: Claim, checks: readonly CheckEvidence[], edits: readonly EditEvidence[]): ClaimVerdict {
  if (claim.admitted) return { claim, status: "admitted" }
  if (claim.kind === "done" && !edits.some((edit) => edit.relevant)) return { claim, status: "unknown" }
  const supporting = SUPPORTED_BY[claim.kind]
  const last = latest(checks.filter((check) => supporting.has(check.kind)))
  if (last === undefined) {
    // Checks of other kinds mean verification happened somewhere this session cannot see (remote runners, CI);
    // only a session with no check at all, or a claim that quotes no observed result, is flagged.
    if (claim.reported || checks.length > 0) return { claim, status: "unknown" }
    return { claim, status: "unsupported", reason: "no-check" }
  }
  if (last.outcome === "failed") return { claim, status: "unsupported", reason: "last-check-failed", receipt: receiptOf(last) }
  if (last.outcome === "unknown") return { claim, status: "unknown", receipt: receiptOf(last) }
  const stale = latest(edits.filter((edit) => edit.relevant && edit.at > last.at))
  if (stale !== undefined) {
    return { claim, status: "unsupported", reason: "stale-after-edit", receipt: receiptOf(last), invalidatedBy: { entryId: stale.entryId, paths: stale.paths } }
  }
  return { claim, status: "supported", receipt: receiptOf(last) }
}

/** Evaluates each claim at the answer's branch position: evidence at or after `answerAt` is never consulted. */
export function matchClaims(timeline: Timeline, claims: readonly Claim[], answerAt: number): ClaimVerdict[] {
  const checks = timeline.checks.filter((check) => check.at < answerAt)
  const edits = timeline.edits.filter((edit) => edit.at < answerAt)
  return claims.map((claim) => judge(claim, checks, edits))
}

export const isFlagged = (verdict: ClaimVerdict): boolean => verdict.status === "unsupported"
