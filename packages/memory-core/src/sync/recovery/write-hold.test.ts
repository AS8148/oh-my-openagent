import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { dirname } from "node:path";
import * as Resilient from "../../fs/resilient";
import * as Fsync from "../../journal/fsync";
import { createRejectionCounter } from "../crypto/rejection.ts";
import { createRecoveryBridge, recoverOnFreshDevice } from "./index.ts";
import { fakeAuthenticator } from "./testing/fake-passkey.test-support.ts";
import {
	createWorld,
	freshStateDir,
	newDevice,
	RP_ID,
	removeWorldStateDirs,
	transportFor,
} from "./testing/world.test-support.ts";
import { holdWrites, loadWriteHold } from "./write-hold.ts";

afterAll(removeWorldStateDirs);

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
});

describe("the write hold survives a power loss (#10450)", () => {
	test("the staged hold is fsynced before the rename, and the directories after it", async () => {
		const stateDir = freshStateDir();
		const calls: string[] = [];
		const syncFile = Fsync.syncJournalFile;
		const syncDir = Fsync.syncJournalDirectory;
		const rename = Resilient.rename;
		spies.push(
			spyOn(Fsync, "syncJournalFile").mockImplementation(async (path) => {
				calls.push(`sync-file ${path.endsWith(".tmp") ? "staging" : path}`);
				return syncFile(path);
			}),
			spyOn(Fsync, "syncJournalDirectory").mockImplementation(async (path) => {
				calls.push(`sync-dir ${path === stateDir ? "state" : "hold"}`);
				return syncDir(path);
			}),
			spyOn(Resilient, "rename").mockImplementation(async (from, to) => {
				calls.push("rename");
				expect(dirname(String(to))).toBe(dirname(String(from)));
				return rename(from, to);
			}),
		);
		await holdWrites(stateDir, "acct", "cred");
		expect(calls).toEqual([
			"sync-dir state",
			"sync-file staging",
			"rename",
			"sync-dir hold",
		]);
		expect(await loadWriteHold(stateDir, "acct")).toEqual({
			held: true,
			credentialId: "cred",
		});
	});

	test("a crash while the hold is made durable stops recovery before its join is sent", async () => {
		const world = await createWorld();
		const device = await newDevice();
		const stateDir = freshStateDir();
		const before = world.server.chain(world.account).length;
		spies.push(
			spyOn(Fsync, "syncJournalFile").mockImplementation(async () => {
				throw new Error("the device lost power");
			}),
		);
		await expect(
			recoverOnFreshDevice({
				account: world.account,
				rpId: RP_ID,
				keyring: device.keyring,
				bridge: createRecoveryBridge(
					fakeAuthenticator(world.provider),
					device.keyring,
				),
				transport: transportFor(world, device),
				rejections: createRejectionCounter(),
				stateDir,
			}),
		).rejects.toThrow("the device lost power");
		expect(world.server.chain(world.account).length).toBe(before);
		expect(await loadWriteHold(stateDir, world.account)).toEqual({
			held: false,
		});
	});
});
