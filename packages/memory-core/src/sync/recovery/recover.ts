import type { DeviceKeyring } from "../keyring-port.ts"
import type { RejectionCounter } from "../crypto/rejection.ts"
import { deviceIdOf } from "../crypto/signatures.ts"
import { openBridgeSealedWrap } from "./key-material.ts"
import { rotationAppend } from "./keyring-append.ts"
import type { RecoverRefusal, RecoveryBridge, RecoveryEvent, RecoveryTransport, TransportRefusal } from "./ports.ts"
import { loadServedChain, recoveryCandidates } from "./served-chain.ts"

export type RecoverOutcome =
  | { readonly ok: true; readonly state: "recovered"; readonly epoch: number; readonly credentialId: string }
  | { readonly ok: true; readonly state: "joined-read-only"; readonly credentialId: string }
  | { readonly ok: false; readonly reason: RecoverRefusal | "approval-required" | "unavailable" | "unverified" | "no-recovery-key" | "bad-device" | "join-refused" | TransportRefusal }

export type RecoverInput = {
  readonly account: string
  readonly rpId: string
  readonly keyring: DeviceKeyring
  readonly bridge: RecoveryBridge | null
  readonly transport: RecoveryTransport
  readonly rejections: RejectionCounter
  readonly acknowledgeUnknownCredential?: boolean
  readonly onEvent?: (event: RecoveryEvent) => void
}

/**
 * Recovery on a fresh device (sync-design section 7): verify the served chain from genesis, let the
 * bridge run the passkey ceremony against every enrolled-and-not-removed key, append its signed
 * recovery-join at the verified head, and then rotate at once to a fresh epoch wrapped only to this
 * device and the key it used. The recovered epoch's key is never used to write; a withheld rotation
 * leaves the device read-only.
 */
export const recoverOnFreshDevice = async (input: RecoverInput): Promise<RecoverOutcome> => {
  const refuse = (reason: Exclude<RecoverOutcome, { ok: true }>["reason"]): RecoverOutcome => {
    input.onEvent?.("sync.recovery.recover_refused")
    return { ok: false, reason }
  }
  if (input.bridge === null || !input.bridge.prfSupported) return refuse("approval-required")
  const keys = input.keyring.publicKeys()
  const id = input.keyring.principal().id
  if ((await deviceIdOf(keys.signing)) !== id) return refuse("bad-device")
  const device = { kind: "device" as const, id, sealing_public_key: keys.sealing, signing_public_key: keys.signing }
  const [served, wrapRows] = await Promise.all([loadServedChain(input.transport, input.account, input.rejections), input.transport.listRecoveryWraps()])
  if (!served.ok) return refuse(served.reason)
  if (wrapRows === null) return refuse("unavailable")
  const { state } = served
  const authority = state.authority
  const head = state.head
  if (authority === null || head === null) return refuse("unverified")
  const candidates = recoveryCandidates(state, wrapRows)
  if (candidates.length === 0) return refuse("no-recovery-key")
  const recovered = await input.bridge.recover({
    account: input.account,
    rpId: input.rpId,
    candidates,
    knownCredentialIds: [...authority.enrolledEver],
    acknowledgeUnknown: input.acknowledgeUnknownCredential === true,
    device,
    join: { epoch: authority.epoch, keyringHead: head.keyring_link, baseSeq: head.seq, priorLink: head.link },
  })
  if (!recovered.ok) return refuse(recovered.reason)
  const join = recovered.join
  const joined = await input.transport.recoveryJoin({
    record: join.body,
    base_seq: head.seq,
    link: join.link,
    keyring_link: join.keyringLink,
    record_sig: join.recordSig,
    wraps: [],
  })
  if (!joined.ok) return refuse(joined.reason)
  const after = await loadServedChain(input.transport, input.account, input.rejections)
  const afterAuthority = after.ok ? after.state.authority : null
  const afterHead = after.ok ? after.state.head : null
  const usedKey = afterAuthority?.registry.get(recovered.credentialId)
  if (!after.ok || afterAuthority === null || afterHead === null || usedKey === undefined || afterHead.keyring_link !== join.keyringLink) {
    return refuse("join-refused")
  }
  const expected = [...afterAuthority.epochOrigins].filter(([epoch, origin]) => epoch < authority.epoch && !afterAuthority.cancelled.has(origin))
  const address = { account: input.account, epoch: authority.epoch, id: `device:${device.id}` }
  const opened = await openBridgeSealedWrap(input.keyring, recovered.deviceWrap, address, new Map(expected))
  if (!opened.ok) return refuse("wrap-refused")
  const retained = opened.material
  const rotation = await rotationAppend(input.keyring, afterHead, input.account, afterAuthority, retained, [device], [usedKey])
  retained.current.fill(0)
  for (const row of retained.history) row.key.fill(0)
  const rotated = await input.transport.appendKeys(rotation)
  input.onEvent?.("sync.recovery.recovered")
  if (!rotated.ok) return { ok: true, state: "joined-read-only", credentialId: recovered.credentialId }
  return { ok: true, state: "recovered", epoch: afterAuthority.epoch + 1, credentialId: recovered.credentialId }
}
