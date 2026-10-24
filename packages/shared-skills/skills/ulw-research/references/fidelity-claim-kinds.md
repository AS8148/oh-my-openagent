# Fidelity Claim Kinds

A report sentence states a plain fact or quote by default. When it claims more than that (that we ran or checked something, that a number is derived, that it is an assumption), the writer marks the claim kind in the placeholder, fill renders the mark as the `data-claim-kind` attribute on the element it writes, and the fidelity gate checks that every marked element cites a ledger row the kind accepts. The gate never infers a claim kind from wording: an unmarked sentence is checked as a plain fact or quote, and only the short phrase list in the last column raises a warning (severity minor, never blocking) when an unmarked sentence reads like the kind.

A `verified` claim is satisfied only by a row whose source snapshot `meta.json` has `kind: "command"` (recorded command or test output). Korean phrases are shown as `\u` escapes, exactly as `claim-kinds.mjs` stores them. The defect codes are in [report-gates.md](report-gates.md).

<!-- claim-kinds:begin (rendered from CLAIM_KINDS; do not edit by hand) -->
| Kind | Placeholder | Attribute fill emits | Accepted row kinds | Required source kind | Defect when unsatisfied | Unmarked warning |
|---|---|---|---|---|---|---|
| `fact` | `{{F12:label}}` | none (or `data-claim-kind="fact"`) | `measured` | any | `claim_kind_mismatch` | none |
| `quote` | `{{Q7:label}}` | none (or `data-claim-kind="quote"`) | `quote` | any | `claim_kind_mismatch` | none |
| `verified` | `{{V:F12:label}}` | `data-claim-kind="verified"` | `measured`, `quote` | `command` | `unsupported_verification` | `verification_claim_unmarked` on "by running", "we ran", "we executed", "we verified by", \uC2E4\uD589\uD574 \uD655\uC778, \uC2E4\uD589\uD558\uC5EC \uAC80\uC99D, \uC9C1\uC811 \uC2E4\uD589 |
| `derived` | `{{D:F12:label}}` | `data-claim-kind="derived"` | `derived`, `converted` | any | `claim_kind_mismatch` | none |
| `assumed` | `{{A:F12:label}}` | `data-claim-kind="assumed"` | `assumed` | any | `claim_kind_mismatch` | none |
<!-- claim-kinds:end -->

Regenerate the table with `node scripts/claim-kinds.mjs --render-doc`.
