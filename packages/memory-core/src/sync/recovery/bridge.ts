import type { DeviceKeyring } from "../keyring-port.ts"
import { enrollInBridge } from "./bridge-enroll.ts"
import { recoverInBridge } from "./bridge-recover.ts"
import type { PasskeyAuthenticator, RecoveryBridge } from "./ports.ts"

/**
 * The reference bridge: the protocol half that runs inside the native bridge process, over that
 * process's platform authenticator and its own device keyring. The desktop main process bridge
 * implements the same requests and results; this one runs it in-process for tests and fixtures.
 */
export const createRecoveryBridge = (authenticator: PasskeyAuthenticator, keyring: DeviceKeyring): RecoveryBridge => ({
  prfSupported: authenticator.prfSupported,
  enroll: (request) => enrollInBridge(authenticator, keyring, request),
  recover: (request) => recoverInBridge(authenticator, request),
  signalRemoved: (rpId, credentialId) => authenticator.signalRemoved(rpId, credentialId),
})
