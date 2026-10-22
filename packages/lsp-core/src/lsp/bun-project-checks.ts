import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createSpawnCommand } from "./process.js";
import { resolveServerBinary } from "./server-installation.js";

export type BunProjectCommand = "check" | "lint" | "format";

export interface BunProjectChecksOptions {
	readonly resolveBun?: (cwd: string) => string | null;
}

export interface BunCommandRun {
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

const BUN_LOCKFILES = ["bun.lock", "bun.lockb", "bunfig.toml"];
const RUNNABLE_EXTENSIONS = ["", ".tsx", ".ts", ".jsx", ".cts", ".cjs", ".js", ".mjs", ".mts"];
const PROBE_TIMEOUT_MS = 10_000;

const probeCache = new Map<string, boolean>();

export function __resetBunCommandProbeCacheForTests(): void {
	probeCache.clear();
}

export function findBunProjectRoot(start: string): string | undefined {
	let dir = resolve(start);
	for (;;) {
		if (BUN_LOCKFILES.some((name) => existsSync(join(dir, name)))) return dir;
		if (packageManagerIsBun(join(dir, "package.json"))) return dir;
		if (existsSync(join(dir, ".git"))) return undefined;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function packageManagerIsBun(packageJsonPath: string): boolean {
	const manifest = readJsonObject(packageJsonPath);
	const packageManager = manifest?.["packageManager"];
	return typeof packageManager === "string" && packageManager.startsWith("bun@");
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

// Bun still runs a project's own script (nearest package.json) named check/lint/format, and for
// lint/format also a file or installed executable of that name, instead of its built-in command.
export function projectShadowsBunCommand(command: BunProjectCommand, cwd: string): boolean {
	const packageJsonDir = nearestPackageJsonDir(cwd);
	if (packageJsonDir !== undefined) {
		const scripts = readJsonObject(join(packageJsonDir, "package.json"))?.["scripts"];
		if (scripts !== null && typeof scripts === "object" && typeof (scripts as Record<string, unknown>)[command] === "string") {
			return true;
		}
	}
	if (command === "check") return false;
	if (RUNNABLE_EXTENSIONS.some((extension) => existsSync(join(cwd, `${command}${extension}`)))) return true;
	let dir = resolve(cwd);
	for (;;) {
		if (existsSync(join(dir, "node_modules", ".bin", command))) return true;
		const parent = dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
}

function nearestPackageJsonDir(start: string): string | undefined {
	let dir = resolve(start);
	for (;;) {
		if (existsSync(join(dir, "package.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

// Feature detection by exit code, in an empty directory: next to a same-named project script an
// older Bun runs that script for `--help` and exits 0.
export function bunHasCommand(bunPath: string, command: BunProjectCommand): boolean {
	const key = `${bunPath}\0${command}`;
	const cached = probeCache.get(key);
	if (cached !== undefined) return cached;
	const emptyDir = mkdtempSync(join(tmpdir(), "omo-bun-probe-"));
	let available = false;
	try {
		const prepared = createSpawnCommand([bunPath, command, "--help"]);
		const result = spawnSync(prepared.command, prepared.args, {
			cwd: emptyDir,
			stdio: "ignore",
			shell: prepared.shell,
			windowsHide: true,
			timeout: PROBE_TIMEOUT_MS,
		});
		available = result.error === undefined && result.status === 0;
	} finally {
		rmSync(emptyDir, { recursive: true, force: true });
	}
	probeCache.set(key, available);
	return available;
}

export function resolveBunProjectCommand(
	command: BunProjectCommand,
	cwd: string,
	options: BunProjectChecksOptions = {},
): string | undefined {
	if (findBunProjectRoot(cwd) === undefined) return undefined;
	if (projectShadowsBunCommand(command, cwd)) return undefined;
	const bunPath = (options.resolveBun ?? defaultResolveBun)(cwd);
	if (!bunPath) return undefined;
	return bunHasCommand(bunPath, command) ? bunPath : undefined;
}

function defaultResolveBun(cwd: string): string | null {
	return resolveServerBinary(["bun"], cwd);
}

export function runBunCommand(bunPath: string, args: readonly string[], cwd: string, signal?: AbortSignal): Promise<BunCommandRun> {
	signal?.throwIfAborted();
	const prepared = createSpawnCommand([bunPath, ...args]);
	return new Promise((resolvePromise, reject) => {
		const child = spawn(prepared.command, prepared.args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			shell: prepared.shell,
			windowsHide: true,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const onAbort = () => child.kill("SIGKILL");
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.once("error", (error) => {
			signal?.removeEventListener("abort", onAbort);
			reject(error);
		});
		child.once("close", (exitCode) => {
			signal?.removeEventListener("abort", onAbort);
			if (signal?.aborted) {
				reject(signal.reason);
				return;
			}
			resolvePromise({
				exitCode,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			});
		});
	});
}
