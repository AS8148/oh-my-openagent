# Changelog fragments

One file per pull request, named `<pr-number>.md`. The body is the exact paragraph(s) that belong
under `## [Unreleased]` in [`CHANGELOG.md`](../../CHANGELOG.md) — a bold lead sentence, the change,
and a link to this PR, for example:

```markdown
**The standalone `omo` binary's `omo setup` carries your OpenCode model choices again.** What
changed, and why. ([#10455](https://github.com/code-yeongyu/oh-my-openagent/pull/10455))
```

Rules:

- Never edit `CHANGELOG.md`'s `## [Unreleased]` section by hand; add or edit your fragment instead.
  Two PRs can then never conflict on the same changelog lines (#9961).
- A user-facing PR must add its fragment; the `changelog-gate` workflow enforces this. The
  `no-changelog` label remains the escape for internal-only changes.
- Fragments are assembled into `## [Unreleased]`, stamped into the released version's section, and
  deleted — all in the release commit (`script/stamp-release-changelog.ts`).
- Assembly order is highest PR number first; duplicate PR ids are refused.
