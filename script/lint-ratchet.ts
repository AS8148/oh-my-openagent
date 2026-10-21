import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

// The three strictness rules every repo enforces. This repo still has hundreds of old sites, so
// they ratchet: each file's count must match the baseline exactly. A rise fails, and so does a drop
// until the baseline is lowered in the same change, so a removed site cannot come back. The old sites
// are rewritten package by package later, each reviewed as a behaviour change.
export const RATCHET_RULES = [
  "typescript/no-explicit-any",
  "typescript/ban-ts-comment",
  "typescript/no-non-null-assertion",
] as const;

export type Counts = Readonly<Record<string, Readonly<Record<string, number>>>>;

type Diagnostic = { readonly code: string; readonly filename: string };

const ruleOf = (code: string): string => code.replace(/^([a-z-]+)\(([a-z-]+)\)$/, "$1/$2");

export const countByFile = (diagnostics: readonly Diagnostic[], root: string): Counts => {
  const counts: Record<string, Record<string, number>> = {};
  for (const { code, filename } of diagnostics) {
    const file = NodePath.relative(root, NodePath.resolve(root, filename))
      .split(NodePath.sep)
      .join("/");
    const rule = ruleOf(code);
    const perFile = (counts[file] ??= {});
    perFile[rule] = (perFile[rule] ?? 0) + 1;
  }
  return counts;
};

export type Change = {
  readonly file: string;
  readonly rule: string;
  readonly before: number;
  readonly after: number;
};

export const compare = (baseline: Counts, current: Counts) => {
  const increases: Change[] = [];
  const decreases: Change[] = [];
  const files = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  for (const file of [...files].toSorted()) {
    for (const rule of RATCHET_RULES) {
      const before = baseline[file]?.[rule] ?? 0;
      const after = current[file]?.[rule] ?? 0;
      if (after > before) increases.push({ file, rule, before, after });
      if (after < before) decreases.push({ file, rule, before, after });
    }
  }
  return { increases, decreases };
};

const sorted = (counts: Counts): Counts =>
  Object.fromEntries(
    Object.keys(counts)
      .toSorted()
      .map((file) => [
        file,
        Object.fromEntries(
          Object.entries(counts[file] ?? {}).toSorted(([a], [b]) => a.localeCompare(b)),
        ),
      ]),
  );

// The tracked JS/TS sources (never built bundles or vendored output), linted with only the three rules.
const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/;
const CONFIG = "script/lint-ratchet.oxlintrc.json";

const run = (root: string, command: string, args: readonly string[]) =>
  NodeChildProcess.spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

const lint = (root: string): Counts => {
  const listed = run(root, "git", ["ls-files", "-z"]);
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  const files = listed.stdout.split("\0").filter((file) => SOURCE.test(file));
  const diagnostics: Diagnostic[] = [];
  // Batches keep each argv under the OS limit.
  for (let start = 0; start < files.length; start += 2000) {
    const result = run(root, NodePath.join(root, "node_modules/.bin/oxlint"), [
      "-c",
      CONFIG,
      "--format",
      "json",
      ...files.slice(start, start + 2000),
    ]);
    if (result.error !== undefined || (result.status !== 0 && result.status !== 1))
      throw new Error(`oxlint failed (status ${String(result.status)}): ${result.stderr}`);
    const parsed: { readonly diagnostics: readonly Diagnostic[] } = JSON.parse(result.stdout);
    diagnostics.push(...parsed.diagnostics);
  }
  return countByFile(diagnostics, root);
};

const main = () => {
  const root = NodePath.resolve(import.meta.dirname, "..");
  const baselinePath = NodePath.join(root, "script/lint-ratchet.baseline.json");
  const current = lint(root);
  if (NodeProcess.argv.includes("--update")) {
    NodeFS.writeFileSync(baselinePath, `${JSON.stringify(sorted(current), null, 2)}\n`);
    console.log(`lint-ratchet: baseline written for ${Object.keys(current).length} files`);
    return;
  }
  const baseline: Counts = JSON.parse(NodeFS.readFileSync(baselinePath, "utf8"));
  const { increases, decreases } = compare(baseline, current);
  for (const { file, rule, before, after } of increases)
    console.error(`${file}: ${rule} went up from ${before} to ${after}`);
  for (const { file, rule, before, after } of decreases)
    console.error(
      `${file}: ${rule} went down from ${before} to ${after}; lower the baseline in this change`,
    );
  if (increases.length > 0)
    console.error(`lint-ratchet: new code must not add ${RATCHET_RULES.join(", ")}.`);
  if (decreases.length > 0)
    console.error(
      "lint-ratchet: run `bun run lint:ratchet:update` and commit the baseline, so removed sites cannot come back.",
    );
  if (increases.length > 0 || decreases.length > 0) NodeProcess.exit(1);
  console.log("lint-ratchet: every count matches the baseline");
};

if (import.meta.main) main();
