import { nextLink } from "../crypto/links.ts"
import { recordPayload, verifyTagged } from "../crypto/signatures.ts"
import { b64urlDecode, b64urlEncode, jcsBytes, sha256B64 } from "../crypto/vendor/sync-format/jcs.ts"
import { signFramed } from "../crypto/vendor/sync-format/keys.ts"
import { deriveRecoveryKeys, disposeRecoveryKeys, publicKeyText, type RecoveryKeyPairs, recoveryPrfSalt, recoveryUserHandle } from "./derive.ts"
import { disposeMaterial, openWrapWithKey, sealWrap } from "./key-material.ts"
import type { PasskeyAuthenticator, RecoverBridgeRequest, RecoverBridgeResult, RecoveryCandidate, SignedJoin } from "./ports.ts"

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index])

/**
 * The stale-prefix check: an account-matched credential the chain never enrolled most likely
 * means the served history hides a newer enrollment. Skipped where the platform cannot enumerate.
 */
const hasUnknownCredential = async (authenticator: PasskeyAuthenticator, request: RecoverBridgeRequest): Promise<boolean> => {
  const discovered = await authenticator.discover(request.rpId)
  if (discovered === null) return false
  const handle = await recoveryUserHandle(request.account)
  const known = new Set(request.knownCredentialIds)
  return discovered.some((credential) => sameBytes(credential.userHandle, handle) && !known.has(credential.credentialId))
}

const anchorHolds = async (account: string, candidate: RecoveryCandidate, keys: RecoveryKeyPairs): Promise<"key-mismatch" | "countersign-mismatch" | null> => {
  const derived = publicKeyText(keys)
  if (derived.sealing_public_key !== candidate.key.sealing_public_key || derived.signing_public_key !== candidate.key.signing_public_key) {
    return "key-mismatch"
  }
  const countersign = candidate.countersign
  const payload = { t: "omo-sync/v1/recovery-countersign", account, custody_root: countersign.custodyRoot, predecessor: countersign.predecessor, wraps_digest: countersign.wrapsDigest }
  const ok = await verifyTagged("omo-sync/v1/recovery-countersign", payload, b64urlEncode(keys.signPublic), countersign.signature)
  return ok ? null : "countersign-mismatch"
}

const signJoin = async (request: RecoverBridgeRequest, credentialId: string, keys: RecoveryKeyPairs): Promise<SignedJoin | null> => {
  const body = {
    kind: "recovery-join",
    account: request.account,
    epoch: request.join.epoch,
    keyring_head: request.join.keyringHead,
    principal: { ...request.device },
    credential_id: credentialId,
  }
  const digest = await sha256B64(jcsBytes(body))
  const link = await nextLink(request.join.priorLink, digest)
  const keyringLink = await nextLink(request.join.keyringHead, digest)
  if (link === null || keyringLink === null) return null
  const fields = { account: request.account, base_seq: request.join.baseSeq, digest, epoch: request.join.epoch, link, keyring_link: keyringLink }
  return { body, digest, link, keyringLink, recordSig: await signFramed("omo-sync/v1/record", recordPayload(fields), keys.signSeed) }
}

/**
 * Bridge-side recovery (sync-design section 7, steps 2 to 5): one PRF assertion with user
 * verification over every enrolled candidate's salt, the anchor check of the derived keys against
 * the enrolling record, the recovery wrap opened under its verified address, its material
 * re-sealed to this device's own sealing key, and the recovery-join signed at the verified head.
 * The PRF output and both private keys are overwritten before this returns, on every path.
 */
export const recoverInBridge = async (authenticator: PasskeyAuthenticator, request: RecoverBridgeRequest): Promise<RecoverBridgeResult> => {
  if (!authenticator.prfSupported) return { ok: false, reason: "no-prf" }
  if (!request.acknowledgeUnknown && (await hasUnknownCredential(authenticator, request))) {
    return { ok: false, reason: "history-incomplete" }
  }
  const salts = new Map<string, Uint8Array>()
  for (const candidate of request.candidates) {
    salts.set(candidate.key.credential_id, await recoveryPrfSalt(request.account, b64urlDecode(candidate.key.enrollment_nonce)))
  }
  const assertion = await authenticator.assert({ rpId: request.rpId, challenge: crypto.getRandomValues(new Uint8Array(32)), prfSalts: salts })
  if (assertion === null) return { ok: false, reason: "cancelled" }
  const prfOutput = assertion.prfOutput
  if (!assertion.flags.userVerified) {
    prfOutput?.fill(0)
    return { ok: false, reason: "no-user-verification" }
  }
  const candidate = request.candidates.find((entry) => entry.key.credential_id === assertion.credentialId)
  if (candidate === undefined) {
    prfOutput?.fill(0)
    return { ok: false, reason: "not-enrolled" }
  }
  if (prfOutput === null || prfOutput.length !== 32) return { ok: false, reason: "no-prf" }
  const keys = await deriveRecoveryKeys(prfOutput, b64urlDecode(candidate.key.enrollment_nonce))
  prfOutput.fill(0)
  try {
    const anchor = await anchorHolds(request.account, candidate, keys)
    if (anchor !== null) return { ok: false, reason: anchor }
    const address = { account: request.account, epoch: candidate.wrap.epoch, id: `recovery:${candidate.key.credential_id}` }
    const opened = await openWrapWithKey(keys.sealPrivate, keys.sealPublic, candidate.wrap, address, new Map(candidate.expectedHistory))
    if (!opened.ok) return { ok: false, reason: "wrap-refused" }
    try {
      const deviceAddress = { account: request.account, epoch: address.epoch, id: `device:${request.device.id}` }
      const deviceWrap = await sealWrap(deviceAddress, request.device.sealing_public_key, opened.material)
      const join = await signJoin(request, candidate.key.credential_id, keys)
      if (join === null) return { ok: false, reason: "wrap-refused" }
      return { ok: true, credentialId: candidate.key.credential_id, deviceWrap, join }
    } finally {
      disposeMaterial(opened.material)
    }
  } finally {
    disposeRecoveryKeys(keys)
  }
}
