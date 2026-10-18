import { describe, expect, test } from "bun:test";
import { checkPrChangelog, isUserFacingPath } from "./changelog-gate-rules.ts";

const POLICY = {
  releaseBranchPattern: /^release\//,
  releaseActors: ["release-bot[bot]"],
  userFacingRoots: ["apps/", "src/"],
};
const base = {
  addedFragment: null,
  branch: "feat/thing",
  isReleaseWorkflow: false,
  actor: "someone",
  labels: [] as string[],
  prNumber: 7,
  addedFiles: [] as string[],
  modifiedFiles: [] as string[],
  deletedFiles: [] as string[],
  baseFragments: [] as string[],
  headFragments: [] as string[],
};

describe("the simple rule (identical in every repo)", () => {
  test("any changelog touch — add, modify, delete, or rename side — fails a non-release PR", () => {
    for (const files of [
      { addedFiles: ["CHANGELOG.md"] },
      { modifiedFiles: ["changes.md"] },
      { deletedFiles: ["CHANGELOG.md"] },
    ]) {
      const result = checkPrChangelog({ ...base, ...files }, POLICY);
      expect(result.pass).toBe(false);
      expect(result.reason).toContain("only the release PR");
    }
  });
  test("modifying or deleting an existing fragment fails; only ADDING one's own is allowed", () => {
    const editOthers = checkPrChangelog(
      { ...base, addedFiles: ["apps/api/src/index.ts"], modifiedFiles: ["changes/unreleased/5.md"], addedFragment: { content: "x" } },
      POLICY,
    );
    expect(editOthers.pass).toBe(false);
    expect(editOthers.reason).toContain("immutable");
    const deleteOthers = checkPrChangelog({ ...base, deletedFiles: ["changes/unreleased/5.md"] }, POLICY);
    expect(deleteOthers.pass).toBe(false);
    expect(deleteOthers.reason).toContain("immutable");
  });
  test("a non-numeric fragment name fails at add time", () => {
    const stray = checkPrChangelog(
      { ...base, addedFiles: ["apps/api/src/index.ts", "changes/unreleased/notes.txt"], addedFragment: { content: "x" } },
      POLICY,
    );
    expect(stray.pass).toBe(false);
    expect(stray.reason).toContain("<pr-number>.md");
  });
  test("a user-facing PR with ZERO fragments and no label is refused", () => {
    const zero = checkPrChangelog({ ...base, addedFiles: ["apps/api/src/index.ts"] }, POLICY);
    expect(zero.pass).toBe(false);
    expect(zero.reason).toContain("exactly one fragment (found 0)");
  });
  test("the fragment must be named for THIS PR's number", () => {
    const wrong = checkPrChangelog(
      { ...base, prNumber: 9, addedFiles: ["apps/api/src/index.ts", "changes/unreleased/7.md"], addedFragment: { content: "text" } },
      POLICY,
    );
    expect(wrong.pass).toBe(false);
    expect(wrong.reason).toContain("named for this PR");
  });
  test("a user-facing PR adds exactly one non-empty fragment; two or empty fail", () => {
    const one = checkPrChangelog(
      { ...base, addedFiles: ["apps/api/src/index.ts", "changes/unreleased/7.md"], addedFragment: { content: "Any text. (#7)" } },
      POLICY,
    );
    expect(one.pass).toBe(true);
    expect(one.reason).toContain("#7");
    const two = checkPrChangelog(
      { ...base, addedFiles: ["apps/api/src/index.ts", "changes/unreleased/7.md", "changes/unreleased/8.md"], addedFragment: { content: "x" } },
      POLICY,
    );
    expect(two.pass).toBe(false);
    expect(two.reason).toContain("exactly one");
    const empty = checkPrChangelog(
      { ...base, addedFiles: ["apps/api/src/index.ts", "changes/unreleased/7.md"], addedFragment: { content: " " } },
      POLICY,
    );
    expect(empty.reason).toContain("empty");
  });
  test("the no-changelog label is refused for user-facing paths and passes otherwise", () => {
    expect(checkPrChangelog({ ...base, addedFiles: ["apps/api/src/index.ts"], labels: ["no-changelog"] }, POLICY).pass).toBe(false);
    expect(checkPrChangelog({ ...base, addedFiles: ["docs/guide.md"], labels: ["no-changelog"] }, POLICY).pass).toBe(true);
  });
  test("the no-changelog label cannot carry fragment additions", () => {
    const withFragment = checkPrChangelog(
      { ...base, labels: ["no-changelog"], addedFiles: ["docs/guide.md", "changes/unreleased/999.md"], addedFragment: { content: "x" } },
      POLICY,
    );
    expect(withFragment.pass).toBe(false);
    expect(withFragment.reason).toContain("cannot carry fragment additions");
  });
  test("a renamed fragment (delete + add under --no-renames) is refused as immutable", () => {
    const renamed = checkPrChangelog(
      { ...base, addedFiles: ["changes/unreleased/7.md"], deletedFiles: ["changes/unreleased/5.md"], addedFragment: { content: "text" } },
      POLICY,
    );
    expect(renamed.pass).toBe(false);
    expect(renamed.reason).toContain("immutable");
  });
  test("a non-user-facing PR without fragments passes", () => {
    expect(checkPrChangelog({ ...base, modifiedFiles: ["README.md", "scripts/build.ts"] }, POLICY).pass).toBe(true);
  });
});

describe("release identity and consumption", () => {
  const releaseBase = {
    prNumber: 7,
    addedFragment: null,
    branch: "release/v1.2.0",
    isReleaseWorkflow: true,
    actor: "release-bot[bot]",
    labels: [] as string[],
    addedFiles: [] as string[],
    modifiedFiles: [] as string[],
    deletedFiles: [] as string[],
    baseFragments: ["7.md"],
    headFragments: [] as string[],
  };
  test("branch + workflow marker + release actor may edit and must consume every numeric fragment", () => {
    const ok = checkPrChangelog({ ...releaseBase, deletedFiles: ["changes/unreleased/7.md"], modifiedFiles: ["CHANGELOG.md"] }, POLICY);
    expect(ok.pass).toBe(true);
  });
  test("a .gitkeep is not a fragment on either side", () => {
    const keep = checkPrChangelog({ ...releaseBase, deletedFiles: ["changes/unreleased/7.md"], modifiedFiles: ["CHANGELOG.md"], headFragments: [".gitkeep"] }, POLICY);
    expect(keep.pass).toBe(true);
  });
  test("a release with only .gitkeep at the base has nothing to consume and fails", () => {
    const nothing = checkPrChangelog({ ...releaseBase, modifiedFiles: ["CHANGELOG.md"], baseFragments: [".gitkeep"] }, POLICY);
    expect(nothing.pass).toBe(false);
    expect(nothing.reason).toContain("consume");
  });
  test("a release PR carrying user-facing code is refused", () => {
    const withCode = checkPrChangelog(
      { ...releaseBase, addedFiles: ["apps/api/src/index.ts"], deletedFiles: ["changes/unreleased/7.md"], modifiedFiles: ["CHANGELOG.md"] },
      POLICY,
    );
    expect(withCode.pass).toBe(false);
    expect(withCode.reason).toContain("must not change user-facing files");
  });
  test("a release without a changelog edit fails", () => {
    const noEdit = checkPrChangelog({ ...releaseBase, deletedFiles: ["changes/unreleased/7.md"] }, POLICY);
    expect(noEdit.pass).toBe(false);
    expect(noEdit.reason).toContain("must edit the changelog");
  });
  test("the branch name, the marker, or a wrong actor alone is NOT a release PR", () => {
    const branchOnly = { 
...base, branch: "release/v1.2.0", baseFragments: ["7.md"] as string[] };
    expect(checkPrChangelog({ ...branchOnly, modifiedFiles: ["CHANGELOG.md"] }, POLICY).pass).toBe(false);
    const markerOnly = { 
...base, isReleaseWorkflow: true, baseFragments: ["7.md"] as string[] };
    expect(checkPrChangelog({ ...markerOnly, modifiedFiles: ["CHANGELOG.md"] }, POLICY).pass).toBe(false);
    const wrongActor = { 
...releaseBase, actor: "a-human" };
    expect(checkPrChangelog({ ...wrongActor, modifiedFiles: ["CHANGELOG.md"], deletedFiles: ["changes/unreleased/7.md"] }, POLICY).pass).toBe(false);
  });
});

describe("the classifier", () => {
  test("directory exemptions are root-anchored; snapshots and nested tests are exempt", () => {
    expect(isUserFacingPath("docs/guide.md", POLICY)).toBe(false);
    expect(isUserFacingPath("apps/web/src/docs/page.tsx", POLICY)).toBe(true);
    expect(isUserFacingPath("packages/core/off-worker/statements.generated.ts", POLICY)).toBe(false);
    expect(isUserFacingPath("apps/web/src/fixtures/real-runtime.ts", POLICY)).toBe(true);
    expect(isUserFacingPath("apps/x/__tests__/a.ts", POLICY)).toBe(false);
    expect(isUserFacingPath("src/flow.test.ts.snap", POLICY)).toBe(false);
    expect(isUserFacingPath("src/agents/prompt.md", POLICY)).toBe(true);
    expect(isUserFacingPath("node_modules/x/y.js", POLICY)).toBe(false);
  });
  test("a root without a trailing slash does not swallow longer names", () => {
    const p = { ...POLICY, userFacingRoots: ["src"] } as typeof POLICY;
    expect(isUserFacingPath("srcfoo/x.ts", p)).toBe(false);
    expect(isUserFacingPath("src/x.ts", p)).toBe(true);
  });
});
