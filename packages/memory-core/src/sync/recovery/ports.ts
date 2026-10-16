import type { KeyringBody, KeyringEntry, SyncAuthor, VerifiedWrap, WrapEntry } from "../crypto/entry.ts"
import type { Principal, RecoveryKey } from "../crypto/parse.ts"

/**
 * The platform passkey API the native bridge drives (macOS AuthenticationServices, the Windows
 * WebAuthn API). It lives only inside the bridge process: `prfOutput` never crosses IPC.
 */
export type PasskeyFlags = { readonly userVerified: boolean; readonly backupEligible: boolean; readonly backupState: boolean }

export type PasskeyCreation = {
  readonly credentialId: string
  readonly attachment: "platform" | "cross-platform"
  readonly flags: PasskeyFlags
  readonly prfOutput: Uint8Array | null
}

export type PasskeyAssertion = {
  readonly credentialId: string
  readonly userHandle: Uint8Array
  readonly flags: PasskeyFlags
  readonly prfOutput: Uint8Array | null
}

export type DiscoveredCredential = { readonly credentialId: string; readonly userHandle: Uint8Array }

export interface PasskeyAuthenticator {
  readonly prfSupported: boolean
  create(request: {
    readonly rpId: string
    readonly userHandle: Uint8Array
    readonly userName: string
    readonly challenge: Uint8Array
    readonly prfSalt: Uint8Array
    readonly excludeCredentialIds: ReadonlyArray<string>
    readonly roaming: boolean
  }): Promise<PasskeyCreation | null>
  assert(request: {
    readonly rpId: string
    readonly challenge: Uint8Array
    readonly prfSalts: ReadonlyMap<string, Uint8Array>
  }): Promise<PasskeyAssertion | null>
  /** Discoverable credentials for the RP id, or null where the platform cannot enumerate them. */
  discover(rpId: string): Promise<ReadonlyArray<DiscoveredCredential> | null>
  signalRemoved(rpId: string, credentialId: string): Promise<"signalled" | "unsupported">
}

/** What the enrolling member hands the bridge: public chain facts plus its own current-epoch wrap. */
export type EnrollBridgeRequest = {
  readonly account: string
  readonly rpId: string
  readonly userName: string
  readonly roaming: boolean
  readonly usedCredentialIds: ReadonlyArray<string>
  readonly custodyRoot: string
  readonly predecessor: string
  readonly epoch: number
  readonly deviceWrap: VerifiedWrap
  readonly expectedHistory: ReadonlyArray<readonly [number, string]>
}

export type EnrollRefusal = "cancelled" | "no-prf" | "no-user-verification" | "not-survivable" | "credential-reused" | "device-wrap-refused"

export type EnrollBridgeResult =
  | { readonly ok: true; readonly key: RecoveryKey; readonly countersign: string; readonly wrap: WrapEntry; readonly wrapsDigest: string }
  | { readonly ok: false; readonly reason: EnrollRefusal }

/** One enrolled-and-not-removed key as the verified chain states it, with its committed proofs. */
export type RecoveryCandidate = {
  readonly key: RecoveryKey
  readonly countersign: { readonly custodyRoot: string; readonly predecessor: string; readonly wrapsDigest: string; readonly signature: string }
  readonly wrap: WrapEntry
  readonly expectedHistory: ReadonlyArray<readonly [number, string]>
}

export type RecoverBridgeRequest = {
  readonly account: string
  readonly rpId: string
  readonly candidates: ReadonlyArray<RecoveryCandidate>
  readonly knownCredentialIds: ReadonlyArray<string>
  readonly acknowledgeUnknown: boolean
  readonly device: Principal
  readonly join: { readonly epoch: number; readonly keyringHead: string; readonly baseSeq: number; readonly priorLink: string }
}

export type RecoverRefusal =
  | "cancelled"
  | "no-prf"
  | "no-user-verification"
  | "not-enrolled"
  | "history-incomplete"
  | "key-mismatch"
  | "countersign-mismatch"
  | "wrap-refused"

export type SignedJoin = {
  readonly body: KeyringBody
  readonly digest: string
  readonly link: string
  readonly keyringLink: string
  readonly recordSig: string
}

export type RecoverBridgeResult =
  | { readonly ok: true; readonly credentialId: string; readonly deviceWrap: WrapEntry; readonly join: SignedJoin }
  | { readonly ok: false; readonly reason: RecoverRefusal }

/**
 * The native bridge seen from the engine host. Every request and result is public: PRF output
 * and the derived private keys stay behind it for exactly one operation.
 */
export interface RecoveryBridge {
  readonly prfSupported: boolean
  enroll(request: EnrollBridgeRequest): Promise<EnrollBridgeResult>
  recover(request: RecoverBridgeRequest): Promise<RecoverBridgeResult>
  signalRemoved(rpId: string, credentialId: string): Promise<"signalled" | "unsupported">
}

/** A row of `GET /v1/sync/entries`: ciphertext-free chain metadata. */
export type ChainRow = {
  readonly seq: number
  readonly base_seq: number
  readonly kind: "batch" | "keyring"
  readonly account: string
  readonly epoch: number
  readonly author: SyncAuthor
  readonly digest: string
  readonly link: string
  readonly keyring_link: string | null
  readonly record_sig: string
}

export type RecoveryWrapRow = {
  readonly record: { readonly seq: number; readonly digest: string; readonly keyring_link: string }
  readonly entry: WrapEntry
}

export type KeyringAppendRequest = {
  readonly record: KeyringBody
  readonly base_seq: number
  readonly link: string
  readonly keyring_link: string
  readonly record_sig: string
  readonly wraps: ReadonlyArray<WrapEntry>
}

export type TransportRefusal = "stale_base" | "rate_limited" | "not_found" | "refused"

export type AppendResult = { readonly ok: true; readonly seq: number } | { readonly ok: false; readonly reason: TransportRefusal }

/** The signed-in account's sync routes this module uses (contract 1.17.0 bootstrap reads and appends). */
export interface RecoveryTransport {
  listKeys(): Promise<ReadonlyArray<KeyringEntry> | null>
  listEntries(): Promise<ReadonlyArray<ChainRow> | null>
  listRecoveryWraps(): Promise<ReadonlyArray<RecoveryWrapRow> | null>
  appendKeys(request: KeyringAppendRequest): Promise<AppendResult>
  recoveryJoin(request: KeyringAppendRequest): Promise<AppendResult>
}

export type RecoveryEvent =
  | "sync.recovery.enrolled"
  | "sync.recovery.enroll_refused"
  | "sync.recovery.recovered"
  | "sync.recovery.recover_refused"
  | "sync.recovery.removed"
