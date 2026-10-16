import type { TrustAnchor } from "../crypto/anchor.ts";
import type { RejectionCounter } from "../crypto/rejection.ts";
import type { DeviceKeyring } from "../keyring-port.ts";
import { ownMaterial, rotationAppend, signedAppend } from "./keyring-append.ts";
import type {
	RecoveryBridge,
	RecoveryEvent,
	RecoveryTransport,
	TransportRefusal,
} from "./ports.ts";
import {
	committedWrap,
	expectedHistory,
	loadServedChain,
} from "./served-chain.ts";

export type RemoveOutcome =
	| {
			readonly ok: true;
			readonly epoch: number | null;
			readonly platformSignal: "signalled" | "unsupported";
			readonly deleteFromPasskeyManager: true;
	  }
	| {
			readonly ok: false;
			readonly reason:
				| "unavailable"
				| "unverified"
				| "not-member"
				| "not-enrolled"
				| "confirm-last-key"
				| "wrap-refused"
				| TransportRefusal;
	  };

export type RemoveInput = {
	/** This member device's pinned trust anchor (loadTrustAnchor); no pin means re-pair or recover first. */
	readonly anchor: TrustAnchor;
	readonly account: string;
	readonly rpId: string;
	readonly credentialId: string;
	readonly confirmGivingUpRecovery: boolean;
	readonly keyring: DeviceKeyring;
	readonly bridge: RecoveryBridge | null;
	readonly transport: RecoveryTransport;
	readonly rejections: RejectionCounter;
	readonly onEvent?: (event: RecoveryEvent) => void;
};

/**
 * Removes one recovery key (sync-design section 7): a member-signed `recovery-key-removed` record,
 * then the rotation that excludes it, so no later epoch is wrapped to the removed passkey. The
 * platform provider is told where it offers an API, and the user is always asked to delete the
 * passkey. Removing the last key needs explicit confirmation that recovery is being given up.
 */
export const removeRecoveryKey = async (
	input: RemoveInput,
): Promise<RemoveOutcome> => {
	const served = await loadServedChain(
		input.transport,
		input.account,
		input.rejections,
		input.anchor,
	);
	if (!served.ok)
		return {
			ok: false,
			reason:
				served.reason === "anchor-mismatch" ? "unverified" : served.reason,
		};
	const authority = served.state.authority;
	const head = served.state.head;
	const self = input.keyring.principal().id;
	if (
		authority === null ||
		head === null ||
		authority.members.get(self)?.signing_public_key !==
			input.keyring.publicKeys().signing
	) {
		return { ok: false, reason: "not-member" };
	}
	if (!authority.registry.has(input.credentialId))
		return { ok: false, reason: "not-enrolled" };
	if (authority.registry.size === 1 && !input.confirmGivingUpRecovery)
		return { ok: false, reason: "confirm-last-key" };
	const deviceWrap = committedWrap(
		served.state,
		authority.epoch,
		`device:${self}`,
	);
	const retained =
		deviceWrap === null
			? null
			: await ownMaterial(
					input.keyring,
					input.account,
					deviceWrap,
					expectedHistory(authority, authority.epoch),
				);
	if (retained === null) return { ok: false, reason: "wrap-refused" };
	const body = {
		kind: "recovery-key-removed",
		account: input.account,
		epoch: authority.epoch,
		credential_id: input.credentialId,
	};
	const removed = await input.transport.appendKeys(
		await signedAppend(input.keyring, head, body, []),
	);
	if (!removed.ok) return { ok: false, reason: removed.reason };
	const platformSignal =
		input.bridge === null
			? "unsupported"
			: await input.bridge.signalRemoved(input.rpId, input.credentialId);
	input.onEvent?.("sync.recovery.removed");
	const after = await loadServedChain(
		input.transport,
		input.account,
		input.rejections,
		input.anchor,
	);
	const afterAuthority = after.ok ? after.state.authority : null;
	const afterHead = after.ok ? after.state.head : null;
	if (
		afterAuthority === null ||
		afterHead === null ||
		afterAuthority.registry.has(input.credentialId)
	) {
		return {
			ok: true,
			epoch: null,
			platformSignal,
			deleteFromPasskeyManager: true,
		};
	}
	const members = [...afterAuthority.members.values()];
	const rotation = await rotationAppend(
		input.keyring,
		afterHead,
		input.account,
		afterAuthority,
		retained,
		members,
		[...afterAuthority.registry.values()],
	);
	const rotated = await input.transport.appendKeys(rotation);
	return {
		ok: true,
		epoch: rotated.ok ? afterAuthority.epoch + 1 : null,
		platformSignal,
		deleteFromPasskeyManager: true,
	};
};
