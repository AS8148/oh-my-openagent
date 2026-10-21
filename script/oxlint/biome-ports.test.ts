import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";

const root = join(import.meta.dir, "../..");
const dir = mkdtempSync(join(tmpdir(), "omo-biome-ports-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Lines that report `rule` when `source` is linted as `name` with the repo's root config.
const flagged = (name: string, source: string, rule: string): string[] => {
  const file = join(dir, name);
  writeFileSync(file, source);
  const result = Bun.spawnSync([join(root, "node_modules/.bin/oxlint"), "-c", join(root, ".oxlintrc.json"), "-f", "unix", file], { cwd: root });
  return result.stdout
    .toString()
    .split("\n")
    .filter((line) => line.includes(`omo(${rule})`))
    .map((line) => line.split(":")[1] ?? "");
};

test("omo/no-enum flags an enum and a const enum, not a union type (Biome noEnum)", () => {
  expect(flagged("enum.ts", "export enum Color { Red }\nexport const enum Mode { A }\nexport type Ok = 'a' | 'b';\n", "no-enum")).toEqual(["1", "2"]);
});

test("omo/no-implicit-any-let flags an untyped let with no value in TypeScript only (Biome noImplicitAnyLet)", () => {
  const source = "let a;\nlet b: string;\nlet c = 1;\nexport { a, b, c };\n";
  expect(flagged("let.ts", source, "no-implicit-any-let")).toEqual(["1"]);
  expect(flagged("let.mjs", source.replace(": string", ""), "no-implicit-any-let")).toEqual([]);
});

test("omo/no-string-case-mismatch flags a case-changed string compared with a literal of the other case", () => {
  const source = [
    "declare const s: string;",
    'export const a = s.toUpperCase() === "abc";',
    'export const b = "Abc" !== s.toLowerCase();',
    'export const c = s.toUpperCase() === "ABC";',
  ].join("\n");
  expect(flagged("case.ts", source, "no-string-case-mismatch")).toEqual(["2", "3"]);
});
