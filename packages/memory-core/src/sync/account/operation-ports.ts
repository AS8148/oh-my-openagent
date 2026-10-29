import { dispatchSyncEffect, type SyncOperationAuthority } from "../operation.ts"
import type { AccountHttp } from "./http.ts"
import type { PairingHttp } from "./pairing-http.ts"

/** Pass authority into the transport too: admission around a token-refreshing helper is too early. */
export const accountOperation = (http: AccountHttp, operation?: SyncOperationAuthority): AccountHttp => ({
  listKeys: () => dispatchSyncEffect(operation, () => http.listKeys(operation)),
  listEntries: () => dispatchSyncEffect(operation, () => http.listEntries(operation)),
  listEntriesAfter: (after) => dispatchSyncEffect(operation, () => http.listEntriesAfter(after, operation)),
  listRecoveryWraps: () => dispatchSyncEffect(operation, () => http.listRecoveryWraps(operation)),
  state: () => dispatchSyncEffect(operation, () => http.state(operation)),
  appendKeys: (request) => dispatchSyncEffect(operation, () => http.appendKeys(request, operation)),
  recoveryJoin: (request) => dispatchSyncEffect(operation, () => http.recoveryJoin(request, operation)),
})

export const pairingOperation = (http: PairingHttp, operation?: SyncOperationAuthority): PairingHttp => ({
  openPending: (account, commitment) => dispatchSyncEffect(operation, () => http.openPending(account, commitment, operation)),
  readPending: (id) => dispatchSyncEffect(operation, () => http.readPending(id, operation)),
  listPending: () => dispatchSyncEffect(operation, () => http.listPending(operation)),
  answerPending: (id, principal, nonce) => dispatchSyncEffect(operation, () => http.answerPending(id, principal, nonce, operation)),
  revealPending: (id, principal, nonce) => dispatchSyncEffect(operation, () => http.revealPending(id, principal, nonce, operation)),
  setAccountSync: (enabled) => dispatchSyncEffect(operation, () => http.setAccountSync(enabled, operation)),
  setDeviceSync: (id, enabled) => dispatchSyncEffect(operation, () => http.setDeviceSync(id, enabled, operation)),
})
