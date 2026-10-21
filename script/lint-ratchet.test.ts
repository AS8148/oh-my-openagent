import { expect, it } from "bun:test";

import { compare, countByFile } from "./lint-ratchet.ts";

const root = "/repo";

it("counts findings per file and rule, relative to the repo root", () => {
  const counts = countByFile(
    [
      { code: "typescript(no-non-null-assertion)", filename: "packages/omo-opencode/src/a.ts" },
      { code: "typescript(no-non-null-assertion)", filename: "/repo/packages/omo-opencode/src/a.ts" },
      { code: "typescript(no-explicit-any)", filename: "packages/omo-opencode/src/a.ts" },
      { code: "typescript(ban-ts-comment)", filename: "script/b.ts" },
    ],
    root,
  );
  expect(counts).toEqual({
    "packages/omo-opencode/src/a.ts": { "typescript/no-non-null-assertion": 2, "typescript/no-explicit-any": 1 },
    "script/b.ts": { "typescript/ban-ts-comment": 1 },
  });
});

it("refuses a count that goes up, including any finding in a file the baseline does not list", () => {
  const { increases } = compare(
    { "packages/omo-opencode/src/a.ts": { "typescript/no-non-null-assertion": 2 } },
    {
      "packages/omo-opencode/src/a.ts": { "typescript/no-non-null-assertion": 3 },
      "packages/omo-opencode/src/new.ts": { "typescript/no-explicit-any": 1 },
    },
  );
  expect(increases).toEqual([
    { file: "packages/omo-opencode/src/a.ts", rule: "typescript/no-non-null-assertion", before: 2, after: 3 },
    { file: "packages/omo-opencode/src/new.ts", rule: "typescript/no-explicit-any", before: 0, after: 1 },
  ]);
});

it("reports a count that goes down, so the baseline must be lowered in the same change", () => {
  const { increases, decreases } = compare(
    {
      "packages/omo-opencode/src/a.ts": { "typescript/no-non-null-assertion": 2 },
      "packages/omo-opencode/src/gone.ts": { "typescript/no-explicit-any": 1 },
    },
    { "packages/omo-opencode/src/a.ts": { "typescript/no-non-null-assertion": 2 } },
  );
  expect(increases).toEqual([]);
  expect(decreases).toEqual([
    { file: "packages/omo-opencode/src/gone.ts", rule: "typescript/no-explicit-any", before: 1, after: 0 },
  ]);
});

it("accepts counts that match the baseline exactly", () => {
  const counts = { "packages/omo-opencode/src/a.ts": { "typescript/no-non-null-assertion": 2 } };
  expect(compare(counts, counts)).toEqual({ increases: [], decreases: [] });
});
