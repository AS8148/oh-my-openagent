import { loadTrustAnchor, TrustPinError } from "../crypto/trust-pin.ts"
import { creatorAnchor } from "../crypto/anchor.ts"
import type { DeviceKeyring } from "../keyring-port.ts"
import { checkSyncOperation, dispatchSyncEffect, type SyncOperationAuthority } from "../operation.ts"
import { type GenesisBridge, GenesisEnableError } from "../genesis/bridge.ts"
import { buildGenesis } from "../genesis/build.ts"
import { completeAccountChain, completeGenesis } from "../genesis/complete.ts"
import { loadGenesisIntent, storeGenesisIntent, withGenesisLock } from "../genesis/intent-store.ts"
import { verifyGenesisRequest } from "../genesis/intent-verify.ts"
import type { AccountHttp } from "./http.ts"
import type { PairingHttp } from "./pairing-http.ts"
import { principalOf } from "./join.ts"
import { accountOperation, pairingOperation } from "./operation-ports.ts"

export type EnableOutcome =
  | { readonly kind: "joined"; readonly created?: true }
  | { readonly kind: "join_required" }
  | { readonly kind: "needs_first_device" }

export interface EnableSyncInput {
  readonly account: string
  readonly serviceDeviceId: string
  readonly keyring: DeviceKeyring
  readonly pinDir: string
  readonly chain: AccountHttp
  readonly pairing: PairingHttp
  readonly serviceOrigin?: string
  readonly rpId?: string
  readonly userName?: string
  readonly roaming?: boolean
  readonly genesis?: GenesisBridge
  readonly operation?: SyncOperationAuthority
}

export async function enableSync(input: EnableSyncInput): Promise<EnableOutcome> {
  const chain = accountOperation(input.chain, input.operation)
  const pairing = pairingOperation(input.pairing, input.operation)
  const captured = { ...input, chain, pairing }
  return withGenesisLock(captured, async () => {
    await checkSyncOperation(input.operation)
    const pin = await loadTrustAnchor(input.pinDir, input.account)
    if (!pin.ok && pin.reason === "corrupt_pin") throw new TrustPinError("corrupt_pin")
    let intent = await loadGenesisIntent(captured)
    const keys = await chain.listKeys()
    if (keys === null) throw new GenesisEnableError("malformed_reply")
    if (pin.ok && keys.length === 0) throw new GenesisEnableError("incomplete_chain")
    if (pin.ok && intent !== null && pin.anchor.genesisDigest !== intent.genesisDigest) throw new TrustPinError("pin_conflict")
    const member = pin.ok ? (await completeAccountChain(captured, pin.anchor)).isMember() : false
    if (!pin.ok && intent !== null && keys.length > 0 && keys[0]?.digest === intent.genesisDigest) {
      const resumed = await completeAccountChain(captured, creatorAnchor(input.account, input.keyring))
      if (resumed.state().genesisDigest !== intent.genesisDigest || !resumed.isMember()) throw new GenesisEnableError("intent_mismatch")
    }
    if (keys.length === 0 && intent === null && !input.genesis?.prfSupported) return { kind: "needs_first_device" }

    // Bootstrap readability is not consent. Every proceeding path restores both switches.
    await pairing.setAccountSync(true)
    await pairing.setDeviceSync(input.serviceDeviceId, true)
    await checkSyncOperation(input.operation)
    if (intent === null && (pin.ok || keys.length > 0)) return { kind: member ? "joined" : "join_required" }
    if (intent === null) {
      const { genesis, serviceOrigin, rpId, userName } = input
      if (!genesis?.prfSupported || !serviceOrigin || !rpId || !userName) throw new GenesisEnableError("missing_configuration")
      const operation = input.operation ?? {
        signal: new AbortController().signal,
        dispatch: async <T>(begin: () => T): Promise<Awaited<T>> => await begin(),
      }
      const result = await dispatchSyncEffect(operation, () => genesis.createGenesis({
        account: input.account, rpId, userName, roaming: input.roaming ?? false, firstDevice: principalOf(input.keyring),
      }, { operation }))
      await checkSyncOperation(operation)
      if (!result.ok) throw new GenesisEnableError("bridge_refused", { cause: result.reason })
      if (result.prepared.body.bootstrap.recovery_key.rp_id !== rpId) throw new GenesisEnableError("intent_mismatch")
      const built = await buildGenesis(input.account, input.keyring, result.prepared, operation)
      await verifyGenesisRequest(input.account, input.keyring, built.request)
      intent = {
        version: 1, account: input.account, serviceOrigin, serviceDeviceId: input.serviceDeviceId,
        syncPrincipal: principalOf(input.keyring), genesisDigest: built.digest, request: built.request,
      }
      await storeGenesisIntent(captured, intent)
    }
    const result = await completeGenesis(captured, intent)
    await checkSyncOperation(input.operation)
    return result === "created" ? { kind: "joined", created: true } : { kind: "join_required" }
  })
}
