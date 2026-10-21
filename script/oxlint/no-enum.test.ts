import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

const root = join(import.meta.dir, "../..");

test("omo/no-enum flags a TypeScript enum and a const enum, and passes a union type (Biome noEnum)", () => {
  const dir = mkdtempSync(join(tmpdir(), "omo-no-enum-"));
  try {
    const file = join(dir, "probe.ts");
    writeFileSync(file, "export enum Color { Red }\nexport const enum Mode { A }\nexport type Ok = 'a' | 'b';\n");
    const result = Bun.spawnSync([join(root, "node_modules/.bin/oxlint"), "-c", join(root, ".oxlintrc.json"), "-f", "unix", file], { cwd: root });
    const lines = result.stdout.toString().split("\n").filter((line) => line.includes("omo(no-enum)"));
    expect(lines.map((line) => line.split(":")[1])).toEqual(["1", "2"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
