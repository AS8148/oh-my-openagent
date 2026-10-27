import { describe, expect, test } from "bun:test";
import { toRepoPath, unusedExports } from "./knip-run.ts";

const report = (file: string) => JSON.stringify({ issues: [{ file, exports: [{ name: "probe" }] }] });

describe("knip paths are one repo-relative POSIX form on every platform", () => {
  test.each([
    ["C:\\r", "C:\\r\\x\\y.ts", "x/y.ts"],
    ["C:\\r", "c:/R/x\\y.ts", "x/y.ts"],
    ["C:\\r", "x\\y.ts", "x/y.ts"],
    ["/r", "/r/x/y.ts", "x/y.ts"],
    ["/r", "x/y.ts", "x/y.ts"],
  ])("toRepoPath(%p, %p) is %p", (root, path, expected) => {
    expect(toRepoPath(root, path)).toBe(expected);
  });

  test("unusedExports keys Windows-form report paths in POSIX form", () => {
    expect([...unusedExports("C:\\r", report("C:\\r\\x\\y.ts"), "")]).toEqual(["x/y.ts#probe"]);
    expect([...unusedExports("C:\\r", report("x\\y.ts"), "")]).toEqual(["x/y.ts#probe"]);
  });

  test("a reported path outside the knip cwd fails instead of silently missing", () => {
    // An 8.3 short cwd against a long-form file path: the two forms of one directory must not pass unnoticed.
    expect(() => unusedExports("C:\\Users\\RUNNER~1\\t", report("C:\\Users\\runneradmin\\t\\x.ts"), "")).toThrow(
      "outside its cwd",
    );
  });
});
