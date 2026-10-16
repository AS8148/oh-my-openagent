import type { DeviceKeyring } from "../keyring-port.ts";
import { enrollInBridge } from "./bridge-enroll.ts";
import {
	recoverBeginInBridge,
	recoverFinishInBridge,
} from "./bridge-recover.ts";
import type { RecoveryKeyPairs } from "./derive.ts";
import type { PasskeyAuthenticator, RecoveryBridge } from "./ports.ts";
import { createRecoveryHandles } from "./recovery-handles.ts";

export type ReferenceBridgeOptions = {
	readonly now?: () => number;
	/** Sees each derived key pair when it is held, so tests can prove it is zeroed on every exit. */
	readonly onKeysDerived?: (keys: RecoveryKeyPairs) => void;
};

/**
 * The reference bridge: the protocol half that runs inside the native bridge process, over that
 * process's platform authenticator and its own device keyring. The desktop main process bridge
 * implements the same requests and results; this one runs it in-process for tests and fixtures.
 */
export const createRecoveryBridge = (
	authenticator: PasskeyAuthenticator,
	keyring: DeviceKeyring,
	options: ReferenceBridgeOptions = {},
): RecoveryBridge => {
	const store = createRecoveryHandles(options.now);
	const handles = {
		...store,
		hold: (recovery: Parameters<typeof store.hold>[0]) => {
			options.onKeysDerived?.(recovery.keys);
			return store.hold(recovery);
		},
	};
	return {
		prfSupported: authenticator.prfSupported,
		enroll: (request) => enrollInBridge(authenticator, keyring, request),
		recoverBegin: (request) =>
			recoverBeginInBridge(authenticator, handles, request),
		recoverFinish: (request) => recoverFinishInBridge(handles, request),
		recoverAbort: async () => handles.disposeAll(),
		signalRemoved: (rpId, credentialId) =>
			authenticator.signalRemoved(rpId, credentialId),
	};
};
