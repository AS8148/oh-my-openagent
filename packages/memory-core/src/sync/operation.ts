/** Captured owner/account/host lifetime. Dispatch admits the immediate effect, not preparation. */
export interface SyncOperationAuthority {
  readonly signal: AbortSignal
  readonly dispatch: <T>(beginEffect: () => T) => Promise<Awaited<T>>
}

export const dispatchSyncEffect = async <T>(
  operation: SyncOperationAuthority | undefined,
  beginEffect: () => T,
): Promise<Awaited<T>> => {
  operation?.signal.throwIfAborted()
  if (operation === undefined) return await beginEffect()
  return operation.dispatch(() => {
    operation.signal.throwIfAborted()
    return beginEffect()
  })
}

/** Rechecks the host's atomic gate too, even if AbortSignal delivery has not caught up. */
export const checkSyncOperation = (operation: SyncOperationAuthority | undefined): Promise<void> =>
  dispatchSyncEffect(operation, () => undefined)
