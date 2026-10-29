# Color rule implementation evidence

Source workspace: Sisyphus Labs. Repository: code-yeongyu/oh-my-openagent. Tracking issue: #11810. Group: color.

**All nine implementations are present. Exact upstream parity is not achieved.** The retained differences and capture gaps below are part of the handoff, not a green parity claim.

## Verification

- `TMPDIR=/Users/Shared/omo-runs/impeccable-port/tmp/color bun test packages/shared-skills/skills/frontend/scripts/detect/rules/color`: exit 0; 26 pass, 0 fail, 35 expectations, 9 test files.
- `TMPDIR=/Users/Shared/omo-runs/impeccable-port/tmp/color bunx tsgo --noEmit -p packages/shared-skills/skills/frontend/scripts/detect/tsconfig.json`: exit 0. An intermediate sibling decoration test error cleared on the later runs; no out-of-group file was edited.
- `TMPDIR=/Users/Shared/omo-runs/impeccable-port/tmp/color bun packages/shared-skills/scripts/detect-parity.ts /Users/Shared/omo-runs/impeccable-port/impeccable --backend chrome --rules low-contrast,gray-on-color,ai-color-palette,cream-palette,gradient-text,dark-glow,radial-halo,radial-spotlight-glow,design-system-color --json packages/shared-skills/skills/frontend/scripts/detect/rules/color/parity.json`: exit 0. Raw rows are in `parity.json`.
- All 25 TypeScript files have fewer than 250 total lines. A banned-syntax text probe found only the English word "as" inside two prose strings; no prohibited TypeScript construct was found.

## Rule files and parity

Paths are relative to this directory. Every rule also has its same-named `.test.ts` file. The array export is `index.ts` / `COLOR_RULES`.

| Rule file | Tests | Golden-count matches | Clean flag/pass fixture rows |
| --- | ---: | ---: | ---: |
| `low-contrast.ts` | 8 | 29/65 | 11/16 |
| `gray-on-color.ts` | 2 | 1/4 | 1/1 |
| `ai-color-palette.ts` | 4 | 1/24 | 6/6 |
| `cream-palette.ts` | 2 | 6/6 | 2/2 |
| `gradient-text.ts` | 2 | 1/12 | 1/2 |
| `dark-glow.ts` | 2 | 1/15 | 0/0 |
| `radial-halo.ts` | 2 | 5/8 | 0/0 |
| `radial-spotlight-glow.ts` | 2 | 1/1 | 1/1 |
| `design-system-color.ts` | 2 | 0/0 (no token config) | 0/0 (no owner fixture) |

The flag/pass ratios above are the parity runner's fixture-row ratios, not a count of individual element IDs. Some palette fixtures have no flag-/pass-prefixed IDs, so a clean row there does not prove every semantic data-expect case.

## Required captures and runner capabilities

- Capture `animation-play-state`: a paused loading shimmer must report, while a running one must not. Current STYLE_PROPS omits it.
- Capture the individual `scale` / `rotate` / `translate` properties and `transform-origin`, and actual `::before` / `::after` rectangles. The existing pseudo rectangles are null; matrix/size estimates cannot reconstruct all painted coverage.
- Capture `::placeholder` computed style and text rectangles separately from the input/textarea host. Host color does not describe placeholder ink.
- Capture `html` computed style, color-scheme/meta canvas facts and site-name metadata. The collector begins at body and discards head/meta/template/script content.
- Capture text-stroke, mix-blend-mode and the upstream paint/contrast evidence (pixels, raster coverage, filtered paint, hit testing, intrinsic media dimensions). Snapshot colors and bounding boxes cannot determine arbitrary image/filtered contrast.
- PageHit has no optional severity. Upstream advisory-only gradient sheens and decorative/near-bar contrast demotions cannot travel through the current rule interface. This implementation honors the explicit project low-contrast error severity.
- One at-rest snapshot contains no hovered/focused state capture. Raw CSS is not a computed interaction-state snapshot.

## Owner-fixture ID differences

- **gradient-text / gradient-text-states.html**: missed [flag-paused-shimmer]; false positives []. The SDK reports each painted ramp once rather than source-plus-element copies. animation-play-state is not captured, so flag-paused-shimmer is incorrectly exempted as a running shimmer.
- **low-contrast / low-contrast-counted-pairs.html**: missed [flag-name-second, flag-name-third, flag-share-second, flag-share-third, flag-shop-name, flag-note-third, flag-tag-second, flag-hand-second, flag-hand-outlined, flag-grad-second, flag-grad-third]; false positives [pass-vend-word]. Repeated pairs intentionally share one claimant, so the generic flag-id checker incorrectly expects duplicate copies to own findings. Remaining differences: vendor/decorative claimant grouping and outline-specific verdict separation; per-hit advisory severity and text-stroke paint are unavailable.
- **low-contrast / low-contrast-labelled-placeholders.html**: missed [flag-hidden-label, flag-sr-only, flag-first-of-two]; false positives []. The collector does not capture ::placeholder computed styles or placeholder glyph rectangles, so the rule cannot score the hint independently of the host. flag-first-of-two actually has a readable .ink placeholder despite its flag-prefixed ID.
- **low-contrast / low-contrast-paint-grounds.html**: missed [flag-grey-over-parked-fill]; false positives []. Pseudo paints and clipped glyph stops differ from static surfaces. The parked pseudo uses individual scale, which STYLE_PROPS does not capture; flag-grey-over-parked-fill remains missed.
- **low-contrast / low-contrast-pixel-reads.html**: missed [flag-halo-copy-on-pale-photo, flag-link-on-near-opaque-glass]; false positives []. The snapshot contains no pixel samples, image rasters, text-stroke or blend/filtered paint verdict. URL/image backgrounds are left unscored; raw gradient-stop scoring cannot reproduce the upstream screenshot contrast pass.
- **low-contrast / low-contrast-unread-pixels.html**: missed [flag-outlined-copy-under-backdrop-filter]; false positives [pass-white-under-half-wash]. The snapshot contains no pixel samples, image rasters, text-stroke or blend/filtered paint verdict. URL/image backgrounds are left unscored; raw gradient-stop scoring cannot reproduce the upstream screenshot contrast pass.

## Every retained count mismatch

Counts below are upstream static golden / SDK Chromium. Reasons describe retained differences; unresolved counts are not claimed correct.

| Rule | Fixture | Golden / SDK | Reason |
| --- | --- | ---: | --- |
| ai-color-palette | ai-color-palette-brand-hue-headings-only.html | 2 / 3 | Rendered brand-surface hue exemptions and computed gradient findings differ from the static heading/class forms; no owner-id failures. |
| ai-color-palette | ai-color-palette-brand-hue.html | 2 / 1 | Rendered brand-surface hue exemptions and computed gradient findings differ from the static heading/class forms; no owner-id failures. |
| ai-color-palette | ai-color-palette-category-colours.html | 4 / 7 | Role-based category exemptions and computed gradient tiles replace the static heading-only interpretation; no owner-id failures. |
| ai-color-palette | ai-color-palette-code-tokens.html | 0 / 4 | The browser detects the four real paired neon runs and exempts highlighted tokens; the static engine records zero. |
| ai-color-palette | ai-color-palette-muted-violet.html | 3 / 2 | Computed HSL saturation exempts the muted non-heading subtitle; static counts an additional class/source form. |
| ai-color-palette | ai-color-palette.html | 1 / 15 | Computed gradient/neon checks, visibility, category/brand exemptions and suppression of duplicate class/source forms differ from the static palette scan. Counts are not claimed equivalent; named palette fixture IDs are clean. |
| low-contrast | color.html | 15 / 17 | Rendered/composited surface and ink math plus pair aggregation differ from static output. The current snapshot lacks pixels and precise pseudo/paint-stack geometry, and this rule uses conservative stop-based rather than spatial gradient sampling. This count remains unverified, not asserted to be exact parity. |
| gray-on-color | color.html | 7 / 6 | One computed finding represents the concern instead of emitting both class and computed-color forms. |
| ai-color-palette | color.html | 4 / 2 | Computed gradient/neon checks, visibility, category/brand exemptions and suppression of duplicate class/source forms differ from the static palette scan. Counts are not claimed equivalent; named palette fixture IDs are clean. |
| gradient-text | color.html | 3 / 2 | The SDK reports a painted glyph ramp once and excludes flat fills, invisible text and source-only declarations; the static scan also emits CSS/class forms. No owner-id failure except the separately recorded paused shimmer. |
| gray-on-color | computed-forms.html | 3 / 1 | The compiled white text-neutral-0 is near-white, not gray; the browser omits static class-only false positives (documented by the fixture). |
| ai-color-palette | computed-forms.html | 0 / 1 | Computed gradient/neon checks, visibility, category/brand exemptions and suppression of duplicate class/source forms differ from the static palette scan. Counts are not claimed equivalent; named palette fixture IDs are clean. |
| low-contrast | contrast-surfaces.html | 2 / 3 | Rendered/composited surface and ink math plus pair aggregation differ from static output. The current snapshot lacks pixels and precise pseudo/paint-stack geometry, and this rule uses conservative stop-based rather than spatial gradient sampling. This count remains unverified, not asserted to be exact parity. |
| ai-color-palette | contrast-surfaces.html | 0 / 2 | Computed gradient/neon checks, visibility, category/brand exemptions and suppression of duplicate class/source forms differ from the static palette scan. Counts are not claimed equivalent; named palette fixture IDs are clean. |
| gradient-text | contrast-surfaces.html | 6 / 5 | The SDK reports a painted glyph ramp once and excludes flat fills, invisible text and source-only declarations; the static scan also emits CSS/class forms. No owner-id failure except the separately recorded paused shimmer. |
| low-contrast | covered-text-contrast.html | 7 / 5 | Rendered clipping/occlusion and opacity/keyframe gates differ from the static capture; exact hit-testing and animation state are not recorded. |
| ai-color-palette | css-in-prose-should-flag.html | 2 / 0 | Page rules inspect captured painted elements, not source-only declarations, template contents, prose or script strings; the raw static pattern scan has a different surface. |
| gradient-text | css-in-prose-should-flag.html | 5 / 2 | The SDK reports a painted glyph ramp once and excludes flat fills, invisible text and source-only declarations; the static scan also emits CSS/class forms. No owner-id failure except the separately recorded paused shimmer. |
| low-contrast | dark-theme-modern-color.html | 7 / 6 | Rendered/composited surface and ink math plus pair aggregation differ from static output. The current snapshot lacks pixels and precise pseudo/paint-stack geometry, and this rule uses conservative stop-based rather than spatial gradient sampling. This count remains unverified, not asserted to be exact parity. |
| low-contrast | declared-mockups.html | 20 / 16 | Pair aggregation and decorative/vendor grouping differ from the upstream static context classifier. PageHit has no per-hit severity channel; project policy still makes contrast findings errors. |
| low-contrast | fullpage-screenshot-frame.html | 1 / 0 | Rendered/composited surface and ink math plus pair aggregation differ from static output. The current snapshot lacks pixels and precise pseudo/paint-stack geometry, and this rule uses conservative stop-based rather than spatial gradient sampling. This count remains unverified, not asserted to be exact parity. |
| low-contrast | fullpage-screenshot-virtual.html | 0 / 1 | Rendered/composited surface and ink math plus pair aggregation differ from static output. The current snapshot lacks pixels and precise pseudo/paint-stack geometry, and this rule uses conservative stop-based rather than spatial gradient sampling. This count remains unverified, not asserted to be exact parity. |
| dark-glow | glow.html | 17 / 15 | The two tiny status-light cases pass the rendered area-ratio gate, which the static engine cannot measure (documented in the fixture). |
| ai-color-palette | gpt-tells.html | 0 / 1 | Computed gradient/neon checks, visibility, category/brand exemptions and suppression of duplicate class/source forms differ from the static palette scan. Counts are not claimed equivalent; named palette fixture IDs are clean. |
| low-contrast | gradient-surface-contrast.html | 14 / 15 | Rendered/composited surface and ink math plus pair aggregation differ from static output. The current snapshot lacks pixels and precise pseudo/paint-stack geometry, and this rule uses conservative stop-based rather than spatial gradient sampling. This count remains unverified, not asserted to be exact parity. |
| ai-color-palette | gradient-text-one-colour.html | 1 / 0 | A gradient clipped to glyphs is owned by gradient-text; the static palette/source form also charges its colors. |
| gradient-text | gradient-text-one-colour.html | 2 / 1 | The SDK reports a painted glyph ramp once and excludes flat fills, invisible text and source-only declarations; the static scan also emits CSS/class forms. No owner-id failure except the separately recorded paused shimmer. |
| ai-color-palette | gradient-text-states.html | 1 / 0 | A gradient clipped to glyphs is owned by gradient-text; the static palette/source form also charges its colors. |
| gradient-text | gradient-text-states.html | 6 / 3 | The SDK reports each painted ramp once rather than source-plus-element copies. animation-play-state is not captured, so flag-paused-shimmer is incorrectly exempted as a running shimmer. |
| low-contrast | link-text-contrast.html | 16 / 19 | Rendered/composited surface and ink math plus pair aggregation differ from static output. The current snapshot lacks pixels and precise pseudo/paint-stack geometry, and this rule uses conservative stop-based rather than spatial gradient sampling. This count remains unverified, not asserted to be exact parity. |
| low-contrast | linked-url-patterns.html | 3 / 0 | The SDK reads the rendered snapshot rather than the static linked-source expansion; those raw-source contrast candidates are absent. |
| gradient-text | linked-url-patterns.html | 1 / 0 | The SDK reports a painted glyph ramp once and excludes flat fills, invisible text and source-only declarations; the static scan also emits CSS/class forms. No owner-id failure except the separately recorded paused shimmer. |
| radial-halo | linked-url-patterns.html | 1 / 0 | Source-only/linked pattern declarations are not represented as a painted radial gradient on a captured host; no raw HTML/template scan is available in PageSnapshot. |
| low-contrast | low-contrast-borrowed-grounds.html | 14 / 17 | Rendered pseudo faces/scrims/textures add verdicts the static scan does not see; all owner flag/pass IDs are clean. |
| low-contrast | low-contrast-counted-pairs.html | 14 / 16 | Repeated pairs intentionally share one claimant, so the generic flag-id checker incorrectly expects duplicate copies to own findings. Remaining differences: vendor/decorative claimant grouping and outline-specific verdict separation; per-hit advisory severity and text-stroke paint are unavailable. |
| low-contrast | low-contrast-covered-and-masked.html | 4 / 2 | The browser sees only active/unmasked copy; the static scan also reports covered and faded labels. Owner IDs are clean. |
| low-contrast | low-contrast-decorative.html | 26 / 20 | Pair aggregation and decorative/vendor grouping differ from the upstream static context classifier. PageHit has no per-hit severity channel; project policy still makes contrast findings errors. |
| low-contrast | low-contrast-labelled-placeholders.html | 13 / 0 | The collector does not capture ::placeholder computed styles or placeholder glyph rectangles, so the rule cannot score the hint independently of the host. flag-first-of-two actually has a readable .ink placeholder despite its flag-prefixed ID. |
| low-contrast | low-contrast-near-threshold.html | 4 / 3 | The additional static hover-state finding is not represented by a single at-rest snapshot. |
| low-contrast | low-contrast-paint-grounds.html | 8 / 9 | Pseudo paints and clipped glyph stops differ from static surfaces. The parked pseudo uses individual scale, which STYLE_PROPS does not capture; flag-grey-over-parked-fill remains missed. |
| gradient-text | low-contrast-paint-grounds.html | 2 / 3 | The SDK reports a painted glyph ramp once and excludes flat fills, invisible text and source-only declarations; the static scan also emits CSS/class forms. No owner-id failure except the separately recorded paused shimmer. |
| low-contrast | low-contrast-pixel-reads.html | 1 / 0 | The snapshot contains no pixel samples, image rasters, text-stroke or blend/filtered paint verdict. URL/image backgrounds are left unscored; raw gradient-stop scoring cannot reproduce the upstream screenshot contrast pass. |
| dark-glow | low-contrast-pixel-reads.html | 2 / 1 | Rendered perceptibility/area and surface gates, plus omission of duplicate raw stylesheet findings, differ from static counts; image-backed surface pixels are unavailable. |
| low-contrast | low-contrast-resting-states.html | 18 / 20 | Rendered/composited surface and ink math plus pair aggregation differ from static output. The current snapshot lacks pixels and precise pseudo/paint-stack geometry, and this rule uses conservative stop-based rather than spatial gradient sampling. This count remains unverified, not asserted to be exact parity. |
| low-contrast | low-contrast-settled-states.html | 1 / 5 | Finite entrance opacity is settled and full fade loops are excluded; rendered contrast of the white-on-white control and faint footer slogan differs from static capture. Owner IDs are clean. |
| ai-color-palette | low-contrast-settled-states.html | 0 / 1 | Computed gradient/neon checks, visibility, category/brand exemptions and suppression of duplicate class/source forms differ from the static palette scan. Counts are not claimed equivalent; named palette fixture IDs are clean. |
| low-contrast | low-contrast-unread-pixels.html | 3 / 2 | The snapshot contains no pixel samples, image rasters, text-stroke or blend/filtered paint verdict. URL/image backgrounds are left unscored; raw gradient-stop scoring cannot reproduce the upstream screenshot contrast pass. |
| low-contrast | never-painted.html | 14 / 12 | Rendered clipping/occlusion and opacity/keyframe gates differ from the static capture; exact hit-testing and animation state are not recorded. |
| ai-color-palette | never-painted.html | 1 / 0 | Page rules inspect captured painted elements, not source-only declarations, template contents, prose or script strings; the raw static pattern scan has a different surface. |
| gradient-text | never-painted.html | 3 / 2 | The SDK reports a painted glyph ramp once and excludes flat fills, invisible text and source-only declarations; the static scan also emits CSS/class forms. No owner-id failure except the separately recorded paused shimmer. |
| dark-glow | not-at-rest.html | 1 / 0 | Computed visibility, perceptibility and active-cascade gates exclude declarations counted by the static stylesheet scan; no duplicated page-level regex finding is emitted. |
| low-contrast | not-shown-at-capture.html | 12 / 10 | Rendered clipping/occlusion and opacity/keyframe gates differ from the static capture; exact hit-testing and animation state are not recorded. |
| low-contrast | not-visible-at-capture.html | 5 / 2 | Rendered clipping/occlusion and opacity/keyframe gates differ from the static capture; exact hit-testing and animation state are not recorded. |
| ai-color-palette | overlay-positioning.html | 1 / 0 | Page rules inspect captured painted elements, not source-only declarations, template contents, prose or script strings; the raw static pattern scan has a different surface. |
| low-contrast | own-box-surface-and-ink-contrast.html | 11 / 10 | Rendered/composited surface and ink math plus pair aggregation differ from static output. The current snapshot lacks pixels and precise pseudo/paint-stack geometry, and this rule uses conservative stop-based rather than spatial gradient sampling. This count remains unverified, not asserted to be exact parity. |
| ai-color-palette | own-box-surface-and-ink-contrast.html | 0 / 1 | Computed gradient/neon checks, visibility, category/brand exemptions and suppression of duplicate class/source forms differ from the static palette scan. Counts are not claimed equivalent; named palette fixture IDs are clean. |
| low-contrast | page-level-forms-dark-contents.html | 1 / 2 | The collector omits html/meta canvas facts and pseudo rectangles; the SDK cannot reproduce root/background paint and metadata-driven dark canvas decisions exactly. |
| dark-glow | page-level-forms-dark-contents.html | 2 / 0 | The snapshot excludes template contents and script strings read by static pattern forms; root/meta canvas facts are also not captured. Those source-only glows cannot be reproduced by this PageRule. |
| dark-glow | page-level-forms-dark-meta.html | 1 / 0 | The snapshot excludes template contents and script strings read by static pattern forms; root/meta canvas facts are also not captured. Those source-only glows cannot be reproduced by this PageRule. |
| low-contrast | page-level-forms-dark-pseudo.html | 0 / 2 | The collector omits html/meta canvas facts and pseudo rectangles; the SDK cannot reproduce root/background paint and metadata-driven dark canvas decisions exactly. |
| dark-glow | page-level-forms-dark-pseudo.html | 1 / 0 | The snapshot excludes template contents and script strings read by static pattern forms; root/meta canvas facts are also not captured. Those source-only glows cannot be reproduced by this PageRule. |
| dark-glow | page-level-forms-dark-root.html | 2 / 0 | The snapshot excludes template contents and script strings read by static pattern forms; root/meta canvas facts are also not captured. Those source-only glows cannot be reproduced by this PageRule. |
| ai-color-palette | page-level-forms-dark.html | 0 / 1 | Page rules inspect captured painted elements, not source-only declarations, template contents, prose or script strings; the raw static pattern scan has a different surface. |
| dark-glow | page-level-forms-dark.html | 1 / 0 | The snapshot excludes template contents and script strings read by static pattern forms; root/meta canvas facts are also not captured. Those source-only glows cannot be reproduced by this PageRule. |
| dark-glow | page-level-forms-white-canvas.html | 1 / 0 | The snapshot excludes template contents and script strings read by static pattern forms; root/meta canvas facts are also not captured. Those source-only glows cannot be reproduced by this PageRule. |
| ai-color-palette | page-level-forms.html | 0 / 1 | Page rules inspect captured painted elements, not source-only declarations, template contents, prose or script strings; the raw static pattern scan has a different surface. |
| gradient-text | page-level-forms.html | 4 / 1 | The SDK reports a painted glyph ramp once and excludes flat fills, invisible text and source-only declarations; the static scan also emits CSS/class forms. No owner-id failure except the separately recorded paused shimmer. |
| dark-glow | page-level-forms.html | 3 / 1 | The snapshot excludes template contents and script strings read by static pattern forms; root/meta canvas facts are also not captured. Those source-only glows cannot be reproduced by this PageRule. |
| radial-halo | page-level-forms.html | 1 / 0 | Source-only/linked pattern declarations are not represented as a painted radial gradient on a captured host; no raw HTML/template scan is available in PageSnapshot. |
| ai-color-palette | paint-that-shows.html | 1 / 2 | Computed gradient/neon checks, visibility, category/brand exemptions and suppression of duplicate class/source forms differ from the static palette scan. Counts are not claimed equivalent; named palette fixture IDs are clean. |
| gradient-text | paint-that-shows.html | 4 / 1 | The SDK reports a painted glyph ramp once and excludes flat fills, invisible text and source-only declarations; the static scan also emits CSS/class forms. No owner-id failure except the separately recorded paused shimmer. |
| dark-glow | paint-that-shows.html | 3 / 1 | Rendered perceptibility/area and surface gates, plus omission of duplicate raw stylesheet findings, differ from static counts; image-backed surface pixels are unavailable. |
| low-contrast | painted-at-capture.html | 3 / 2 | Rendered clipping/occlusion and opacity/keyframe gates differ from the static capture; exact hit-testing and animation state are not recorded. |
| ai-color-palette | painted-gate-coverage.html | 0 / 2 | Computed gradient/neon checks, visibility, category/brand exemptions and suppression of duplicate class/source forms differ from the static palette scan. Counts are not claimed equivalent; named palette fixture IDs are clean. |
| dark-glow | painted-gate-coverage.html | 4 / 1 | Computed visibility, perceptibility and active-cascade gates exclude declarations counted by the static stylesheet scan; no duplicated page-level regex finding is emitted. |
| dark-glow | pattern-walk-inactive-at-rules.html | 3 / 1 | Computed visibility, perceptibility and active-cascade gates exclude declarations counted by the static stylesheet scan; no duplicated page-level regex finding is emitted. |
| low-contrast | placeholder-contrast.html | 4 / 0 | The collector does not capture ::placeholder computed styles or placeholder glyph rectangles, so the rule cannot score the hint independently of the host. flag-first-of-two actually has a readable .ink placeholder despite its flag-prefixed ID. |
| low-contrast | radial-spotlight-glow.html | 0 / 4 | Rendered/composited surface and ink math plus pair aggregation differ from static output. The current snapshot lacks pixels and precise pseudo/paint-stack geometry, and this rule uses conservative stop-based rather than spatial gradient sampling. This count remains unverified, not asserted to be exact parity. |
| ai-color-palette | radial-spotlight-glow.html | 0 / 8 | Computed gradient/neon checks, visibility, category/brand exemptions and suppression of duplicate class/source forms differ from the static palette scan. Counts are not claimed equivalent; named palette fixture IDs are clean. |
| low-contrast | surface-resolution-contrast.html | 11 / 14 | Rendered/composited surface and ink math plus pair aggregation differ from static output. The current snapshot lacks pixels and precise pseudo/paint-stack geometry, and this rule uses conservative stop-based rather than spatial gradient sampling. This count remains unverified, not asserted to be exact parity. |
| low-contrast | third-party-widgets-carousels.html | 2 / 3 | Pair aggregation and decorative/vendor grouping differ from the upstream static context classifier. PageHit has no per-hit severity channel; project policy still makes contrast findings errors. |
| low-contrast | transient-opacity-contrast.html | 6 / 8 | Rendered/composited surface and ink math plus pair aggregation differ from static output. The current snapshot lacks pixels and precise pseudo/paint-stack geometry, and this rule uses conservative stop-based rather than spatial gradient sampling. This count remains unverified, not asserted to be exact parity. |
| low-contrast | unread-surface-contrast.html | 11 / 3 | The snapshot contains no pixel samples, image rasters, text-stroke or blend/filtered paint verdict. URL/image backgrounds are left unscored; raw gradient-stop scoring cannot reproduce the upstream screenshot contrast pass. |
| gray-on-color | unread-surface-contrast.html | 0 / 1 | Resolved rendered surfaces and composited gradient stops differ from static unresolved-surface interpretation; no owner-fixture gray-on-color ID fails. |
| dark-glow | unread-surface-contrast.html | 3 / 2 | Rendered perceptibility/area and surface gates, plus omission of duplicate raw stylesheet findings, differ from static counts; image-backed surface pixels are unavailable. |
| low-contrast | visual-contrast-gates.html | 3 / 4 | The snapshot contains no pixel samples, image rasters, text-stroke or blend/filtered paint verdict. URL/image backgrounds are left unscored; raw gradient-stop scoring cannot reproduce the upstream screenshot contrast pass. |
| low-contrast | visual-contrast-sampling.html | 1 / 3 | The snapshot contains no pixel samples, image rasters, text-stroke or blend/filtered paint verdict. URL/image backgrounds are left unscored; raw gradient-stop scoring cannot reproduce the upstream screenshot contrast pass. |
| ai-color-palette | visual-contrast-sampling.html | 0 / 1 | Computed gradient/neon checks, visibility, category/brand exemptions and suppression of duplicate class/source forms differ from the static palette scan. Counts are not claimed equivalent; named palette fixture IDs are clean. |
| gradient-text | visual-contrast-sampling.html | 2 / 1 | The SDK reports a painted glyph ramp once and excludes flat fills, invisible text and source-only declarations; the static scan also emits CSS/class forms. No owner-id failure except the separately recorded paused shimmer. |
| radial-halo | visual-contrast-sampling.html | 0 / 1 | The dark-surface decision uses the rendered host/ancestor fill instead of the static whole-page dark heuristic; a visible dark section can therefore produce a halo on a page the static scan calls light. |

## Files created

- `low-contrast.ts`
- `low-contrast.test.ts`
- `gray-on-color.ts`
- `gray-on-color.test.ts`
- `ai-color-palette.ts`
- `ai-color-palette.test.ts`
- `cream-palette.ts`
- `cream-palette.test.ts`
- `gradient-text.ts`
- `gradient-text.test.ts`
- `dark-glow.ts`
- `dark-glow.test.ts`
- `radial-halo.ts`
- `radial-halo.test.ts`
- `radial-spotlight-glow.ts`
- `radial-spotlight-glow.test.ts`
- `design-system-color.ts`
- `design-system-color.test.ts`
- `index.ts`
- `support/gradients.ts`
- `support/text-colors.ts`
- `support/palette-roles.ts`
- `support/painted-text.ts`
- `support/contrast-pairs.ts`
- `support/animation-opacity.ts`
- `parity.json` (development evidence, not runtime code)
- `REPORT.md` (this report)

No commit, push, PR, external post or live model call was made by this child.
