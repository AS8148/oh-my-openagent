import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

import { mkdir, readFile, rename, rm, writeFile } from "../../fs/resilient";

/**
 * The persisted read-only state of a recovered device (#10412 review M3). A recovery whose rotation
 * the server withheld leaves the device joined but on the recovered epoch, whose key it must never
 * write with; that fact outlives the process, so it is written next to the trust pin and only a
 * recovery that stores and verifies its rotation releases it. The sync engine reads it before any
 * write. A hold file that does not parse still holds: the state fails closed.
 */
export type WriteHold =
	| { readonly held: false }
	| { readonly held: true; readonly credentialId: string | null };

export const WRITE_HOLD_NEXT_STEP =
	"Run recovery again on this device; writes resume once its key rotation is stored.";

const holdPath = (stateDir: string, account: string): string =>
	join(
		stateDir,
		"recovery-hold",
		`${createHash("sha256").update(account, "utf8").digest("base64url")}.json`,
	);

const isMissing = (error: unknown): boolean =>
	error instanceof Error && "code" in error && error.code === "ENOENT";

export const loadWriteHold = async (
	stateDir: string,
	account: string,
): Promise<WriteHold> => {
	let raw: string;
	try {
		raw = await readFile(holdPath(stateDir, account), "utf8");
	} catch (error) {
		if (isMissing(error)) return { held: false };
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return { held: true, credentialId: null };
	}
	const credentialId: unknown = Reflect.get(Object(value), "credential_id");
	const sameAccount = Reflect.get(Object(value), "account") === account;
	return {
		held: true,
		credentialId:
			sameAccount && typeof credentialId === "string" ? credentialId : null,
	};
};

/** Records that writes are held for `account`; written atomically, mode 0600. */
export const holdWrites = async (
	stateDir: string,
	account: string,
	credentialId: string,
): Promise<void> => {
	const target = holdPath(stateDir, account);
	await mkdir(join(stateDir, "recovery-hold"), {
		recursive: true,
		mode: 0o700,
	});
	const staging = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	const body = { version: 1, account, credential_id: credentialId };
	try {
		await writeFile(staging, `${JSON.stringify(body)}\n`, {
			flag: "wx",
			mode: 0o600,
		});
		await rename(staging, target);
	} finally {
		await rm(staging, { force: true });
	}
};

/** Releases the hold once a rotation is stored and verified; a missing hold is already released. */
export const releaseWriteHold = async (
	stateDir: string,
	account: string,
): Promise<void> => {
	await rm(holdPath(stateDir, account), { force: true });
};
