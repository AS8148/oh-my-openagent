# Unit rules for derived facts

The one definition of which unit a derived or converted fact row carries, and the reviewer's checklist for
`scripts/unit-rules.mjs`. ONE registry (`OPERATION_RULES`) owns, per operation: arity, operand-unit guards, context
fields, result-unit inference, and malformed shapes. `derive()` (`fact-derive.mjs`) and `recompute()`
(`fact-recompute.mjs`) both call it; neither has op-specific unit code. `row.unit` is NEVER used to choose arithmetic;
numeric guards may read `exact` values, unit selection may not. The property tests in
`scripts/fact-unit-rules.test.ts` iterate the registry, so a new operation needs a table row here and cases there.

## Units
- Canonical unit text is stored and compared exactly (case-sensitive symbols). Registered aliases
  (`pp` -> `%p`, `kilometre` -> `km`, ...) are canonicalized ONLY at input (derive/fact add); a relabel to an alias
  at rest is a relabel and is detected.
- `null` = dimensionless. Omitted unit on a derived spec is an error, not null (distinguish omission from declared null).
- Percent `%` stores percentage numerals (20% stores 20). Delta `%p` (percentage points). 1 basis point = 0.01 %p
  (input alias `bp` -> `%p` with /100 scaling).
- Composite units are canonical algebraic strings built by the registry (`USD/kg`, `person`), never by concatenating
  operand strings: equal factors cancel (`USD/(USD/person)` -> `person`).
- Affine scales (temperature: `C`, `F`) are flagged in the unit table; growth/share/ratio refuse them.

## Operation table

| op | arity | operand guards | context fields (persisted on the row) | result unit | malformed -> recompute ok:false |
|---|---|---|---|---|---|
| sum | n>=2 | all units equal after canonicalization; if `%`: `disjoint: true` AND `reference` (one denominator id/text) equal on every operand AND rationale | disjoint, reference, rationale | the common unit (`%` stays `%`) | <2 operands; missing id; unequal units; `%` without disjoint+reference |
| diff | 2 | typed pairs only: U-U -> U (same non-% unit); %-% -> `%p`; %-%p -> `%`; %p-%p -> `%p`; %p-% REFUSED | none | per the pair rule | arity; invalid pair |
| growth | 2 (from,to) | equal non-affine units; same entity; two different valid_at; from.exact > 0 | none | `%` (= 100(to-from)/from) | arity; unequal/affine units; entity/valid_at; from<=0 |
| share | 2 (part,whole) | equal non-affine units; whole.exact > 0; 0 <= part <= whole | none | `%` (= 100 part/whole) | arity; units; whole<=0; part outside [0,whole] |
| ratio | 2 (num,den) | non-affine units; den.exact != 0 | none | registry composite: equal units -> null; else canonical `U(num)/U(den)` with cancellation | arity; den=0 |
| convert | 1 | U(a) has a registered factor to `target`; currencies REFUSED (use expr with a dated rate row) | target (persisted; the ONLY accepted declared unit, compared to the persisted target, not to `row.unit`) | the persisted target | arity; target missing; no factor; declared unit != persisted target |
| expr | n>=1 | formula ids == operand set; node rules: `+`/`-` follow the diff/sum typed-pair rules (so `20% - 10%` is `%p`, never `%`); `*` and `/` compose canonical composites, `%`/`%p` operands normalize by /100 to dimensionless first; result must be fully inferred: NO rationale escape | none | the inferred unit; an explicit null->`%` conversion is a separate `convert`-like node (`pct()`) | formula/operand id mismatch; parse error; /0; uninferable unit |

## Invariants (property tests iterate the table)
1. For each op: generate valid typed operands (rational boundaries, aliases at input, composites, %/%p, affine,
   metadata, conversion targets, repeated expr refs), derive, assert `recompute(row).ok === true`.
2. Relabel: for each op, set `unit` to every different canonical string/null (incl. aliases and other valid targets),
   regenerate render, keep exact: `recompute(row).ok === false` naming the expected unit; and `derive()` with that
   declared unit is refused.
3. Malformed: per op, the table's malformed list (operands null, arity, missing id, invalid rational, `%` sum without
   disjoint/reference, invalid diff pair, affine growth, share out of range, ratio /0, convert no target, expr id
   mismatch / /0): `recompute` returns `ok:false`, never throws.
4. Nested derived rows are verified recursively (operands may be derived rows); cycles are refused.
5. Render precision rules are unchanged (fewest decimal places for sum/diff/%p; fewest sig figs otherwise).

## Decisions
- Q1: the canonical composite goes in `unit` (consumers compare `unit` text); no side field.
- Q2: expr with an unresolved unit is REFUSED; a known-unit `a*b/c` is inferable, so no rationale escape exists.
- Q3: canonical `%p`, input alias `pp` (matches units.mjs).
- Q4: strict null metadata: null matches only null; required metadata must be present.

## Out of scope (follow-ups)
Per-capita identity, named index/base and index-point differences, weighted means, dated FX / nominal-real bases,
same-currency denomination scaling (M/B), summing ratios over a common base. Each needs its own table row + tests.

## Implementation notes

- Context fields live in the row's `context` column (null or an object; optional when reading a ledger written before
  it existed): sum stores `{ disjoint, reference }`, convert stores `{ target }`. The sum rationale stays in `rationale`.
- `reference` is either one text (the caller asserts one shared denominator) or a map from each operand id to its
  denominator; the map passes only when every operand names the same non-empty denominator.
- Operand rows are read through the same input canonicalizer, so a measured row stored as `pp` or `kilometre` derives
  as `%p` or `km`. A measured row stored in `bp` is refused until it is stored as `%p` (scaled by 0.01), and a declared
  result unit of `bp` is refused for the same reason.
- A ratio over `%` or `%p` operands with unequal units is refused (use expr, where `%` enters `*` and `/` as a fraction).
- convert reads its target from `to`; a declared `unit` is optional and must equal that target.
- expr still returns compatibility `unchecked`: the population/snapshot predicates do not apply to expr, while its unit
  is always inferred.
