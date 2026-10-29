import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runWithRequestContext } from "../request-context.js";
import { withHostJsRuntime } from "./host-js-runtime.js";
import { __resetServerBinaryResolutionCacheForTests } from "./server-installation.js";
import { findServerForExtension } from "./server-resolution.js";

const tempDirectories: string[] = [];
let previousPath: string | undefined;
const BUN = "/opt/bun/bin/bun";

function makeTempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "lsp-host-js-"));
	tempDirectories.push(root);
	return root;
}

function writeFile(path: string, content: string): string {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
	chmodSync(path, 0o755);
	return path;
}

function installTypescriptLanguageServer(root: string): { bin: string; cli: string } {
	writeFileSync(join(root, "package.json"), "{}\n");
	const cli = writeFile(
		join(root, "node_modules", "typescript-language-server", "lib", "cli.mjs"),
		"#!/usr/bin/env node\nexport {};\n",
	);
	const bin = join(root, "node_modules", ".bin", "typescript-language-server");
	mkdirSync(join(bin, ".."), { recursive: true });
	symlinkSync(join("..", "typescript-language-server", "lib", "cli.mjs"), bin);
	return { bin, cli: realpathSync(cli) };
}

beforeEach(() => {
	previousPath = process.env["PATH"];
	__resetServerBinaryResolutionCacheForTests();
});

afterEach(() => {
	if (previousPath === undefined) delete process.env["PATH"];
	else process.env["PATH"] = previousPath;
	for (const directory of tempDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
	__resetServerBinaryResolutionCacheForTests();
});

describe("withHostJsRuntime", () => {
	test("#given a Bun host and the npm bin link of typescript-language-server #then it runs the real script with Bun", () => {
		const { bin, cli } = installTypescriptLanguageServer(makeTempRoot());

		expect(withHostJsRuntime("typescript", [bin, "--stdio"], { bunExecPath: BUN })).toEqual([
			BUN,
			cli,
			"--stdio",
		]);
	});

	test("#given a Node host #then the command is unchanged", () => {
		const { bin } = installTypescriptLanguageServer(makeTempRoot());

		expect(withHostJsRuntime("typescript", [bin, "--stdio"], { bunExecPath: undefined })).toEqual([bin, "--stdio"]);
	});

	test("#given another node-based server #then the command is unchanged", () => {
		const root = makeTempRoot();
		const eslint = writeFile(join(root, "eslint-ls.js"), "#!/usr/bin/env node\n");

		expect(withHostJsRuntime("eslint", [eslint, "--stdio"], { bunExecPath: BUN })).toEqual([eslint, "--stdio"]);
	});

	test("#given a typescript command that is a native binary or shell shim #then the command is unchanged", () => {
		const root = makeTempRoot();
		const shim = writeFile(join(root, "typescript-language-server"), "#!/bin/sh\nexec node cli.mjs \"$@\"\n");

		expect(withHostJsRuntime("typescript", [shim, "--stdio"], { bunExecPath: BUN })).toEqual([shim, "--stdio"]);
	});
});

describe("findServerForExtension on a Bun host", () => {
	test("#given a repo-local typescript-language-server #when a .ts file is looked up #then the server is spawned by this Bun", () => {
		const root = makeTempRoot();
		const { cli } = installTypescriptLanguageServer(root);
		process.env["PATH"] = join(root, "definitely-empty");

		const result = runWithRequestContext(
			{
				cwd: root,
				projectConfigPaths: [join(root, ".codex", "lsp-client.json")],
				userConfigPath: join(root, "home-config", "lsp-client.json"),
				installDecisionsPath: join(root, "home-config", "lsp-install-decisions.json"),
				capabilities: { installDecisionTool: false },
			},
			() => findServerForExtension(".ts"),
		);

		expect(result.status).toBe("found");
		if (result.status !== "found") throw new Error("expected a found server");
		expect(result.server.id).toBe("typescript");
		expect(result.server.command).toEqual([process.execPath, cli, "--stdio"]);
	});
});
