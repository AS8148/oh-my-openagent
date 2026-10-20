# Model Capabilities Maintenance

This project treats model capability resolution as a layered system:

1. runtime metadata from connected providers
2. `models.dev` bundled/runtime snapshot data
3. explicit compatibility aliases
4. heuristic fallback as the last resort

## Internal policy

- Built-in OmO agent/category requirement models must use canonical model IDs.
- Aliases exist only to preserve compatibility with historical OmO names or provider-specific decorations.
- New decorated names like `-high`, `-low`, or `-thinking` should not be added to built-in requirements when a canonical model ID plus structured settings can express the same thing.
- If a provider or config input still uses an alias, normalize it at the edge and continue internally with the canonical ID.

## When adding an alias

- Add the alias rule to `packages/model-core/src/model-capability-aliases.ts`.
- Include a rationale for why the alias exists.
- Add or update tests so the alias is covered explicitly.
- Ensure the alias canonical target exists in the bundled `models.dev` snapshot.

## Hand-scoped snapshot entries

`packages/omo-opencode/src/generated/model-capabilities.generated.json` has two writers:

- the scheduled `refresh-model-capabilities` workflow (`bun run build:model-capabilities`, fetched from `models.dev`), and
- feature PRs that add one scoped entry for a model the upstream catalog does not carry yet (for example #10187 added `gemini-4-argon`).

Hand-scoped entries must survive the scheduled refresh. A refresh merges: it adds or updates upstream entries and keeps committed entries upstream lacks, unless a PR retires them on purpose. A refresh that overwrites the file drops those entries; the refresh PR open at the time of writing (#7531) was missing 501 of them (#10665).

When you add an entry by hand, keep it to the entry itself: do not regenerate the whole file from `models.dev` in a feature PR, and leave `generatedAt` alone. When you review a refresh PR, check the removed entries before merging.

## Guardrails

`bun run test:model-capabilities` enforces the following invariants:

- exact alias targets must exist in the bundled snapshot
- exact alias keys must not silently become canonical `models.dev` IDs
- pattern aliases must not rewrite canonical snapshot IDs
- built-in requirement models must stay canonical and snapshot-backed

The scheduled `refresh-model-capabilities` workflow runs these guardrails before opening an automated snapshot refresh PR.
