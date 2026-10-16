import { createDeviceKeyring, type DeviceKeyring, generateDeviceKeyMaterial } from "../../keyring-port.ts"
import { appendEntries, type ChainState, emptyChain } from "../chain.ts"
import type { KeyringBody, WrapEntry } from "../entry.ts"
import { wrapSetDigest } from "../links.ts"
import { isObject, type JsonObject } from "../parse.ts"
import { createRejectionCounter } from "../rejection.ts"
import { deviceIdOf, taggedHash } from "../signatures.ts"
import { compareWrapEntries } from "../vendor/sync-format/canonical.ts"
import type { JsonValue } from "../vendor/sync-format/jcs.ts"
import { signFramed } from "../vendor/sync-format/keys.ts"
import { ACCOUNT, appendKeyring, record, recoverySigningSeed } from "./sync-v1.test-support.ts"

export const newDeviceKeyring = async (): Promise<DeviceKeyring> => {
  const material = generateDeviceKeyMaterial()
  const id = await deviceIdOf(material.publicKeys.signing)
  if (id === null) throw new Error("generated signing key does not decode")
  return createDeviceKeyring(id, material)
}

const fixtureBootstrap = (): { readonly custodyNonce: JsonValue; readonly recoveryKey: JsonObject } => {
  const bootstrap = record("genesis").body["bootstrap"]
  if (!isObject(bootstrap)) throw new Error("fixture genesis has no bootstrap")
  const recoveryKey = bootstrap["recovery_key"]
  if (!isObject(recoveryKey)) throw new Error("fixture bootstrap has no recovery key")
  return { custodyNonce: bootstrap["custody_nonce"] ?? null, recoveryKey }
}

/**
 * A verified one-record chain whose genesis names `keyring` as the first device and commits
 * `deviceWrap` as its epoch-1 wrap, countersigned by the fixture's first recovery key. The wrap
 * bytes are opaque to the chain, so a test chooses what they seal and to whom.
 */
export const verifiedGenesisFor = async (keyring: DeviceKeyring, deviceWrap: string): Promise<ChainState> => {
  const { custodyNonce, recoveryKey } = fixtureBootstrap()
  const keys = keyring.publicKeys()
  const firstDevice = { kind: "device", id: keyring.principal().id, sealing_public_key: keys.sealing, signing_public_key: keys.signing }
  const wraps: WrapEntry[] = [
    { epoch: 1, id: `device:${firstDevice.id}`, wrap: deviceWrap },
    { epoch: 1, id: `recovery:${String(recoveryKey["credential_id"])}`, wrap: "R".repeat(43) },
  ].sort(compareWrapEntries)
  const set = await wrapSetDigest(wraps)
  if (!set.ok) throw new Error("wrap set")
  const bootstrap = { account: ACCOUNT, custody_nonce: custodyNonce, first_device: firstDevice, recovery_key: recoveryKey }
  const custodyRoot = await taggedHash("omo-sync/v1/custody-root", bootstrap)
  const countersign = await signFramed(
    "omo-sync/v1/recovery-countersign",
    { t: "omo-sync/v1/recovery-countersign", account: ACCOUNT, custody_root: custodyRoot, predecessor: "", wraps_digest: set.digest },
    await recoverySigningSeed("key1"),
  )
  const body: KeyringBody = { kind: "genesis", account: ACCOUNT, epoch: 1, bootstrap, custody_root: custodyRoot, countersign, wraps_digest: set.digest }
  const genesis = await appendKeyring({ seq: 0, link: "", keyring_link: "" }, body, { keyring }, wraps)
  const outcome = await appendEntries(emptyChain(ACCOUNT), [genesis], createRejectionCounter())
  if (!outcome.ok) throw new Error(`test genesis refused: ${outcome.reason}`)
  return outcome.state
}
