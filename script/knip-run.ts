import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { Glob } from "bun";

export const REPO_ROOT = realpathSync(join(import.meta.dir, ".."));

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const runKnip = async (cwd: string, args: string[]) => {
  const proc = Bun.spawn([process.execPath, "run", "knip:check", ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { stdout, stderr, code: await proc.exited };
};

// Tracked plus untracked-but-not-gitignored files: what knip can see. Gitignored build output (dist/) is never an entry.
export const repoFiles = (): string[] =>
  execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: REPO_ROOT, maxBuffer: 256 << 20 })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);

export const knipConfig = async (): Promise<Record<string, unknown>> => {
  const config: unknown = Bun.JSONC.parse(await Bun.file(join(REPO_ROOT, "knip.jsonc")).text());
  if (!isObject(config)) throw new Error("knip.jsonc is not an object");
  return config;
};

export const packageDirs = async (): Promise<string[]> => {
  const rootPkg: unknown = await Bun.file(join(REPO_ROOT, "package.json")).json();
  const patterns = isObject(rootPkg) && Array.isArray(rootPkg["workspaces"]) ? rootPkg["workspaces"] : [];
  const config = await knipConfig();
  const configured = isObject(config["workspaces"]) ? Object.keys(config["workspaces"]) : [];
  const dirs = new Set(["."]);
  for (const pattern of [...patterns, ...configured])
    if (typeof pattern === "string" && pattern !== ".")
      for await (const pkg of new Glob(`${pattern}/package.json`).scan({ cwd: REPO_ROOT })) dirs.add(posix.dirname(pkg));
  return [...dirs];
};

// A temp copy of the files knip can see, with each package's node_modules linked. The caller removes it.
// realpath: on macOS tmpdir() and /tmp are symlinks into /private, and knip misses probes under the link.
export const copyRepo = async (): Promise<string> => {
  const copy = realpathSync(mkdtempSync(join(tmpdir(), "knip-probe-")));
  for (const file of repoFiles()) {
    const src = join(REPO_ROOT, file);
    if (!existsSync(src) || lstatSync(src).isDirectory()) continue;
    mkdirSync(dirname(join(copy, file)), { recursive: true });
    cpSync(src, join(copy, file), { verbatimSymlinks: true });
  }
  for (const dir of await packageDirs()) {
    const modules = join(REPO_ROOT, dir, "node_modules");
    if (existsSync(modules) && existsSync(join(copy, dir)) && !existsSync(join(copy, dir, "node_modules")))
      symlinkSync(modules, join(copy, dir, "node_modules"), "dir");
  }
  return copy;
};

export const unusedExports = (stdout: string, stderr: string): Set<string> => {
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
  return unused;
};
