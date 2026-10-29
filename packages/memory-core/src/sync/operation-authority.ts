/** Captured caller authority; account identity remains enforced by the selected account ports. */
export interface SyncOperationAuthority {
  readonly signal: AbortSignal
  /** Immediately invoke the effect, or throw if its captured owner has retired. */
  readonly admit: <T>(dispatch: () => T) => T
}

export interface SyncOperationOptions {
  readonly signal?: AbortSignal
  readonly authority?: SyncOperationAuthority
}

export function admitSyncOperation<T>(options: SyncOperationOptions, dispatch: () => T): T {
  options.signal?.throwIfAborted()
  const authority = options.authority
  if (authority === undefined) return dispatch()
  authority.signal.throwIfAborted()
  return authority.admit(dispatch)
}
