import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, sep } from "node:path";
import { Glob } from "bun";

// Every knip entry must have its exports checked (includeEntryExports), so an unused export added to
// an entry fails `knip:check`.
//
// The probe table is knip's OWN resolved entry list: `knip --debug` logs every entry glob it expands
// ("Finding entry paths", "... from plugins", "... from plugins (ignore exports)", "... from
// package.json") with the resolved `paths`, including files its plugins found run by path from
// package.json scripts and CI workflows. The test reads those paths instead of parsing commands itself.
//
// A coarse scan of package.json scripts and workflow `run:` lines cross-checks that list: any file it
// sees run by path that knip does not list as an entry fails the test. The scan can only add
// failures; it never adds or removes table rows.

const ROOT = realpathSync(join(import.meta.dir, ".."));
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const KNIP_TIMEOUT_MS = 600_000;
const FORCED_UNCHECKED_FILE = join(import.meta.dir, "knip-entry-exports.unchecked.json");

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const runKnip = async (cwd: string, args: string[]) => {
  const proc = Bun.spawn([process.execPath, "run", "knip:check", ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { stdout, stderr, code: await proc.exited };
};

let entriesOnce: Promise<string[]> | undefined;
const knipEntries = (): Promise<string[]> => {
  entriesOnce ??= (async () => {
    const { stdout } = await runKnip(ROOT, ["--debug"]);
    const visible = new Set(repoFiles());
    const entries = new Set<string>();
    let sections = 0;
    for (const section of stdout.split(/^\[[^\]\n]*\] Finding entry paths/m).slice(1)) {
      sections += 1;
      const paths = /paths: \[([\s\S]*?)\]/.exec(section)?.[1] ?? "";
      for (const [, path] of paths.matchAll(/'([^']+)'/g)) {
        if (path === undefined || !SOURCE_EXT.test(path)) continue;
        const rel = relative(ROOT, path).split(sep).join("/");
        if (visible.has(rel)) entries.add(rel);
      }
    }
    if (sections === 0) throw new Error(`knip --debug printed no "Finding entry paths" section:\n${stdout.slice(0, 2000)}`);
    return [...entries].sort();
  })();
  return entriesOnce;
};

// Tracked plus untracked-but-not-gitignored files: what knip can see. Gitignored build output (dist/) is never an entry.
const repoFiles = (): string[] =>
  execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, maxBuffer: 256 << 20 })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);

// Coarse on purpose: per shell segment, the first source-file word is taken as run by path (all of
// them when the segment says `test`), resolved against the package dir, the repo root, and every
// `cd`/`--cwd`/`--prefix`/`working-directory` dir seen. Non-files are dropped; extra real files only over-match.
const scannedFiles = (command: string, bases: Iterable<string>, visible: ReadonlySet<string>): string[] => {
  const segments = command.split(/\n|&&|\|\||;|\|/).map((segment) =>
    segment
      .split(/\s+/)
      .map((word) => word.replace(/^["'(]+|["')]+$/g, ""))
      .filter((word) => word !== ""),
  );
  const dirs = new Set([...bases, "."]);
  for (const words of segments)
    words.forEach((word, n) => {
      if ((word === "cd" || word === "--cwd" || word === "--prefix") && words[n + 1]) dirs.add(words[n + 1] ?? ".");
      if (word.startsWith("--cwd=")) dirs.add(word.slice("--cwd=".length));
    });
  const files: string[] = [];
  for (const words of segments) {
    const sources = words.filter((word) => SOURCE_EXT.test(word));
    for (const word of words.includes("test") ? sources : sources.slice(0, 1))
      for (const dir of dirs) {
        const rel = posix.normalize(posix.join(dir, word));
        if (visible.has(rel) && statSync(join(ROOT, rel)).isFile()) files.push(rel);
      }
  }
  return files;
};

const collect = (node: unknown, key: string): string[] => {
  if (Array.isArray(node)) return node.flatMap((item) => collect(item, key));
  if (!isObject(node)) return [];
  const own = typeof node[key] === "string" ? [node[key]] : [];
  return [...own, ...Object.values(node).flatMap((value) => collect(value, key))];
};

const knipConfig = async (): Promise<Record<string, unknown>> => {
  const config: unknown = Bun.JSONC.parse(await Bun.file(join(ROOT, "knip.jsonc")).text());
  if (!isObject(config)) throw new Error("knip.jsonc is not an object");
  return config;
};

const packageDirs = async (): Promise<string[]> => {
  const rootPkg: unknown = await Bun.file(join(ROOT, "package.json")).json();
  const patterns = isObject(rootPkg) && Array.isArray(rootPkg["workspaces"]) ? rootPkg["workspaces"] : [];
  const config = await knipConfig();
  const configured = isObject(config["workspaces"]) ? Object.keys(config["workspaces"]) : [];
  const dirs = new Set(["."]);
  for (const pattern of [...patterns, ...configured])
    if (typeof pattern === "string" && pattern !== ".")
      for await (const pkg of new Glob(`${pattern}/package.json`).scan({ cwd: ROOT })) dirs.add(posix.dirname(pkg));
  return [...dirs];
};

const scanRunByPath = async (): Promise<Map<string, string>> => {
  const found = new Map<string, string>();
  const visible = new Set(repoFiles());
  const add = (file: string, source: string) => {
    if (!found.has(file)) found.set(file, source);
  };
  for (const dir of await packageDirs()) {
    const pkg: unknown = await Bun.file(join(ROOT, dir, "package.json")).json();
    const scripts = isObject(pkg) && isObject(pkg["scripts"]) ? pkg["scripts"] : {};
    for (const script of Object.values(scripts))
      if (typeof script === "string") for (const file of scannedFiles(script, [dir], visible)) add(file, `${dir}/package.json`);
  }
  for await (const name of new Glob("*.{yml,yaml}").scan({ cwd: join(ROOT, ".github/workflows") })) {
    const workflow: unknown = Bun.YAML.parse(await Bun.file(join(ROOT, ".github/workflows", name)).text());
    const dirs = collect(workflow, "working-directory");
    for (const run of collect(workflow, "run"))
      for (const file of scannedFiles(run, dirs, visible)) add(file, `.github/workflows/${name}`);
  }
  return found;
};

// The probe run drops every `ignoreIssues` baseline (top level and per workspace): a file-wide
// baseline would hide a probe in that file.
const withoutIgnoreIssues = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(withoutIgnoreIssues);
  if (!isObject(node)) return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => key !== "ignoreIssues")
      .map(([key, value]) => [key, withoutIgnoreIssues(value)]),
  );
};

const copyRepo = async (target: string) => {
  for (const file of repoFiles()) {
    const src = join(ROOT, file);
    if (!existsSync(src) || lstatSync(src).isDirectory()) continue;
    mkdirSync(dirname(join(target, file)), { recursive: true });
    cpSync(src, join(target, file), { verbatimSymlinks: true });
  }
  for (const dir of await packageDirs()) {
    const modules = join(ROOT, dir, "node_modules");
    if (existsSync(modules) && existsSync(join(target, dir)) && !existsSync(join(target, dir, "node_modules")))
      symlinkSync(modules, join(target, dir, "node_modules"), "dir");
  }
};

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("knip export-checks every entry", () => {
  test(
    "every file run by path from scripts or workflows is a knip entry",
    async () => {
      const entries = new Set(await knipEntries());
      const notEntries = [...(await scanRunByPath())]
        .filter(([file]) => !entries.has(file))
        .map(([file, source]) => `${file} (run by path from ${source}, not a knip entry)`);
      expect(notEntries).toEqual([]);
    },
    KNIP_TIMEOUT_MS,
  );

  test(
    "a probe export appended to each knip entry is reported as unused",
    async () => {
      const entries = await knipEntries();
      expect(entries.length).toBeGreaterThan(0);

      const copy = mkdtempSync(join(tmpdir(), "knip-entry-probe-"));
      scratch.push(copy);
      await copyRepo(copy);
      await Bun.write(join(copy, "knip.probe.json"), JSON.stringify(withoutIgnoreIssues(await knipConfig())));

      const probes = entries.map((file, n) => ({ file, name: `zzKnipProbe_${n}` }));
      for (const probe of probes) appendFileSync(join(copy, probe.file), `\nexport const ${probe.name} = 1;\n`);

      const { stdout, stderr } = await runKnip(copy, ["--config", "knip.probe.json", "--reporter", "json"]);
      const start = stdout.indexOf("{");
      if (start < 0) throw new Error(`knip printed no JSON report:\n${stderr.slice(0, 4000)}`);
      const report: unknown = JSON.parse(stdout.slice(start));
      const issues = isObject(report) && Array.isArray(report["issues"]) ? report["issues"] : [];
      const unused = new Set<string>();
      for (const issue of issues) {
        if (!isObject(issue) || typeof issue["file"] !== "string" || !Array.isArray(issue["exports"])) continue;
        for (const item of issue["exports"])
          if (isObject(item) && typeof item["name"] === "string") unused.add(`${issue["file"]}#${item["name"]}`);
      }
      const missed = probes.filter((probe) => !unused.has(`${probe.file}#${probe.name}`)).map((probe) => probe.file);
      const forced: unknown = await Bun.file(FORCED_UNCHECKED_FILE).json();
      const forcedFiles = new Set(isObject(forced) && Array.isArray(forced["files"]) ? forced["files"] : []);
      const unexpected = missed.filter((file) => !forcedFiles.has(file));
      const stale = [...forcedFiles].filter((file) => typeof file !== "string" || !missed.includes(file));
      console.log(
        `knip-entry-probe: ${probes.length} entries probed, ${probes.length - missed.length} reported, ${missed.length - unexpected.length} knip-forced unchecked, ${unexpected.length} missed`,
      );
      expect({ unexpected, stale, stderr: unexpected.length > 0 ? stderr.slice(0, 4000) : "" }).toEqual({
        unexpected: [],
        stale: [],
        stderr: "",
      });
    },
    KNIP_TIMEOUT_MS,
  );
});
