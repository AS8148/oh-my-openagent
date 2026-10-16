import type { RejectionCounter } from "../crypto/rejection.ts";
import { deviceIdOf } from "../crypto/signatures.ts";
import { pinTrustAnchor } from "../crypto/trust-pin.ts";
import type { DeviceKeyring } from "../keyring-port.ts";
import { openBridgeSealedWrap } from "./key-material.ts";
import { rotationAppend } from "./keyring-append.ts";
import type {
	RecoverRefusal,
	RecoveryBridge,
	RecoveryEvent,
	RecoveryTransport,
	TransportRefusal,
} from "./ports.ts";
import {
	loadServedChain,
	recoveryCandidates,
	servedSaltInputs,
} from "./served-chain.ts";

export type RecoverOutcome =
	| {
			readonly ok: true;
			readonly state: "recovered";
			readonly epoch: number;
			readonly credentialId: string;
	  }
	| {
			readonly ok: true;
			readonly state: "joined-read-only";
			readonly credentialId: string;
	  }
	| {
			readonly ok: false;
			readonly reason:
				| RecoverRefusal
				| "approval-required"
				| "unavailable"
				| "unverified"
				| "no-recovery-key"
				| "bad-device"
				| "join-refused"
				| TransportRefusal;
	  };

export type RecoverInput = {
	readonly account: string;
	readonly rpId: string;
	readonly keyring: DeviceKeyring;
	readonly bridge: RecoveryBridge | null;
	readonly transport: RecoveryTransport;
	readonly rejections: RejectionCounter;
	/** Where this device keeps its trust pin; recovery sets it from the anchored walk. */
	readonly stateDir: string;
	readonly acknowledgeUnknownCredential?: boolean;
	readonly onEvent?: (event: RecoveryEvent) => void;
};

/**
 * Recovery on a fresh device (sync-design section 7, review r3 option A): the bridge asserts with
 * salts read from the served records and holds the derived keys; the served chain is then walked
 * anchored at the record that enrolled the touched credential with exactly those keys; only a
 * candidate from that anchored state reaches finish; after the join the device pins the anchor and
 * rotates at once to a fresh epoch wrapped only to this device and the key it used. The recovered epoch's key is never used to write; a withheld rotation
 * leaves the device read-only.
 */
export const recoverOnFreshDevice = async (
	input: RecoverInput,
): Promise<RecoverOutcome> => {
	const refuse = (
		reason: Exclude<RecoverOutcome, { ok: true }>["reason"],
	): RecoverOutcome => {
		input.onEvent?.("sync.recovery.recover_refused");
		return { ok: false, reason };
	};
	if (input.bridge === null || !input.bridge.prfSupported)
		return refuse("approval-required");
	const keys = input.keyring.publicKeys();
	const id = input.keyring.principal().id;
	if ((await deviceIdOf(keys.signing)) !== id) return refuse("bad-device");
	const device = {
		kind: "device" as const,
		id,
		sealing_public_key: keys.sealing,
		signing_public_key: keys.signing,
	};
	const salts = await servedSaltInputs(input.transport);
	if (salts === null) return refuse("unavailable");
	if (salts.length === 0) return refuse("no-recovery-key");
	const begun = await input.bridge.recoverBegin({
		account: input.account,
		rpId: input.rpId,
		salts,
		knownCredentialIds: salts.map((salt) => salt.credentialId),
		acknowledgeUnknown: input.acknowledgeUnknownCredential === true,
	});
	if (!begun.ok) return refuse(begun.reason);
	const bridge = input.bridge;
	const abort = async (
		reason: Exclude<RecoverOutcome, { ok: true }>["reason"],
	): Promise<RecoverOutcome> => {
		await bridge.recoverAbort(begun.handle);
		return refuse(reason);
	};
	const anchor = {
		kind: "recovery" as const,
		account: input.account,
		credentialId: begun.credentialId,
		sealing_public_key: begun.sealing_public_key,
		signing_public_key: begun.signing_public_key,
	};
	const [served, wrapRows] = await Promise.all([
		loadServedChain(input.transport, input.account, input.rejections, anchor),
		input.transport.listRecoveryWraps(),
	]);
	if (!served.ok)
		return abort(
			served.reason === "anchor-mismatch" ? "key-mismatch" : served.reason,
		);
	if (wrapRows === null) return abort("unavailable");
	const { state } = served;
	const authority = state.authority;
	const head = state.head;
	if (authority === null || head === null) return abort("unverified");
	const candidate = recoveryCandidates(state, wrapRows).find(
		(entry) => entry.key.credential_id === begun.credentialId,
	);
	if (candidate === undefined) return abort("not-enrolled");
	const recovered = await bridge.recoverFinish({
		handle: begun.handle,
		account: input.account,
		candidate,
		device,
		join: {
			epoch: authority.epoch,
			keyringHead: head.keyring_link,
			baseSeq: head.seq,
			priorLink: head.link,
		},
	});
	if (!recovered.ok) return refuse(recovered.reason);
	const join = recovered.join;
	const joined = await input.transport.recoveryJoin({
		record: join.body,
		base_seq: head.seq,
		link: join.link,
		keyring_link: join.keyringLink,
		record_sig: join.recordSig,
		wraps: [],
	});
	if (!joined.ok) return refuse(joined.reason);
	const after = await loadServedChain(
		input.transport,
		input.account,
		input.rejections,
		anchor,
	);
	const afterAuthority = after.ok ? after.state.authority : null;
	const afterHead = after.ok ? after.state.head : null;
	const usedKey = afterAuthority?.registry.get(recovered.credentialId);
	if (
		!after.ok ||
		afterAuthority === null ||
		afterHead === null ||
		usedKey === undefined ||
		afterHead.keyring_link !== join.keyringLink
	) {
		return refuse("join-refused");
	}
	const pin = after.state.pin;
	if (pin === null) return refuse("join-refused");
	await pinTrustAnchor(input.stateDir, input.account, pin);
	const expected = [...afterAuthority.epochOrigins].filter(
		([epoch, origin]) =>
			epoch < authority.epoch && !afterAuthority.cancelled.has(origin),
	);
	const address = {
		account: input.account,
		epoch: authority.epoch,
		id: `device:${device.id}`,
	};
	const opened = await openBridgeSealedWrap(
		input.keyring,
		recovered.deviceWrap,
		address,
		new Map(expected),
	);
	if (!opened.ok) return refuse("wrap-refused");
	const retained = opened.material;
	const rotation = await rotationAppend(
		input.keyring,
		afterHead,
		input.account,
		afterAuthority,
		retained,
		[device],
		[usedKey],
	);
	retained.current.fill(0);
	for (const row of retained.history) row.key.fill(0);
	const rotated = await input.transport.appendKeys(rotation);
	input.onEvent?.("sync.recovery.recovered");
	if (!rotated.ok)
		return {
			ok: true,
			state: "joined-read-only",
			credentialId: recovered.credentialId,
		};
	return {
		ok: true,
		state: "recovered",
		epoch: afterAuthority.epoch + 1,
		credentialId: recovered.credentialId,
	};
};
