import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";

import { parseBunCheckOutput, parseBunLintJson } from "./bun-command-output.js";
import {
	__resetBunCommandProbeCacheForTests,
	bunHasCommand,
	findBunProjectRoot,
	projectShadowsBunCommand,
	resolveBunProjectCommand,
} from "./bun-project-checks.js";
import { createFakeBun, createProject, removeFakeBunFixtures } from "./fake-bun-test-support.js";

afterEach(() => {
	__resetBunCommandProbeCacheForTests();
	removeFakeBunFixtures();
});

describe("findBunProjectRoot", () => {
	it("#given a bun.lock, a bunfig.toml or a bun packageManager #when looked up from a nested directory #then that project root is found", () => {
		for (const marker of [{ "bun.lock": "" }, { "bunfig.toml": "" }, { "package.json": '{"packageManager":"bun@1.4.3"}' }]) {
			const root = createProject({ ...marker, "src/deep/a.ts": "" });
			expect(findBunProjectRoot(join(root, "src", "deep"))).toBe(root);
		}
	});

	it("#given an npm project inside a repository #when looked up #then the walk stops at the repository boundary", () => {
		const root = createProject({ "package.json": '{"packageManager":"npm@11.0.0"}', "package-lock.json": "{}", "src/a.ts": "" });
		expect(findBunProjectRoot(join(root, "src"))).toBeUndefined();
	});
});

describe("projectShadowsBunCommand", () => {
	it("#given a package.json script named like the command #when checked #then the built-in command is shadowed", () => {
		const root = createProject({ "bun.lock": "", "package.json": '{"scripts":{"check":"tsc","lint":"eslint ."}}' });
		expect(projectShadowsBunCommand("check", root)).toBe(true);
		expect(projectShadowsBunCommand("lint", root)).toBe(true);
		expect(projectShadowsBunCommand("format", root)).toBe(false);
	});

	it("#given a lint.ts file #when checked #then lint is shadowed but check is not", () => {
		const root = createProject({ "bun.lock": "", "lint.ts": "", "check.ts": "" });
		expect(projectShadowsBunCommand("lint", root)).toBe(true);
		expect(projectShadowsBunCommand("check", root)).toBe(false);
	});
});

describe("bunHasCommand", () => {
	it("#given a bun without lint #when probed #then only the commands whose --help exits 0 are available", () => {
		const bun = createFakeBun({ commands: ["check"] });
		expect(bunHasCommand(bun.path, "check")).toBe(true);
		expect(bunHasCommand(bun.path, "lint")).toBe(false);
		expect(bunHasCommand(bun.path, "format")).toBe(false);
	});

	it("#given repeated probes #when probed #then each command runs --help once, in an empty directory", () => {
		const bun = createFakeBun({ commands: ["check", "lint"] });
		bunHasCommand(bun.path, "lint");
		bunHasCommand(bun.path, "lint");
		const calls = bun.calls();
		expect(calls.map((call) => call.args)).toEqual([["lint", "--help"]]);
		expect(calls[0]?.cwdEntries).toEqual([]);
	});
});

describe("resolveBunProjectCommand", () => {
	it("#given a non-Bun project #when resolved #then bun is never looked up", () => {
		const root = createProject({ "package.json": "{}", "src/a.ts": "" });
		let lookups = 0;
		expect(resolveBunProjectCommand("check", root, { resolveBun: () => (lookups++, "/unused/bun") })).toBeUndefined();
		expect(lookups).toBe(0);
	});

	it("#given a Bun project and a bun with check #when resolved #then that bun is returned", () => {
		const root = createProject({ "bun.lock": "" });
		const bun = createFakeBun({ commands: ["check"] });
		expect(resolveBunProjectCommand("check", root, { resolveBun: () => bun.path })).toBe(bun.path);
		expect(resolveBunProjectCommand("lint", root, { resolveBun: () => bun.path })).toBeUndefined();
	});
});

describe("bun command output", () => {
	it("#given tsc-style bun check output #when parsed #then diagnostics carry file, 0-based position, code and continuation lines", () => {
		const cwd = createProject({});
		const parsed = parseBunCheckOutput(
			"src/x.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n  The expected type comes from here.\n",
			cwd,
		);
		expect(parsed).toEqual([
			{
				file: join(cwd, "src", "x.ts"),
				diagnostic: {
					range: { start: { line: 2, character: 6 }, end: { line: 2, character: 6 } },
					severity: 1,
					code: "TS2322",
					source: "bun check",
					message: "Type 'string' is not assignable to type 'number'.\nThe expected type comes from here.",
				},
			},
		]);
	});

	it("#given ESLint JSON from bun lint #when parsed #then errors and warnings map to LSP severities", () => {
		const parsed = parseBunLintJson(
			JSON.stringify([
				{
					filePath: "/p/a.ts",
					messages: [
						{ ruleId: "prefer-const", severity: 2, message: "Use const", line: 3, column: 7, endLine: 3, endColumn: 12 },
						{ ruleId: null, severity: 1, message: "Unused directive", line: 1, column: 1 },
					],
				},
			]),
		);
		expect(parsed?.map(({ file, diagnostic }) => [file, diagnostic.severity, diagnostic.code, diagnostic.range.start])).toEqual([
			["/p/a.ts", 1, "prefer-const", { line: 2, character: 6 }],
			["/p/a.ts", 2, undefined, { line: 0, character: 0 }],
		]);
		expect(parseBunLintJson("not json")).toBeUndefined();
	});
});
