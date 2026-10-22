import type { TrackedRpcChildHandle } from "./handle"

// Teardowns of refused starts that are still running. Nothing awaits them on the start path, so session
// shutdown awaits them instead: a POSIX child is spawned detached and outlives a host that exits early.
const pendingTeardowns = new Set<Promise<void>>()

/**
 * Tears down a handle whose first prompt was refused, without holding the caller's start failure up.
 * The refusal already decides the start outcome; process-tree teardown (taskkill on Windows) can outlast
 * the manager's start-report window, and awaiting it there turned a refused start into "started" (#10402).
 * The returned promise settles once teardown has finished and never rejects: a failure goes to onFailure.
 * Until it settles, settleStartTeardowns waits for it.
 */
export function discardUnstartedRpcHandle(
  handle: Pick<TrackedRpcChildHandle, "terminate" | "dispose">,
  onFailure: (error: unknown) => void,
): Promise<void> {
  const teardown = async (): Promise<void> => {
    try {
      await handle.terminate()
    } finally {
      await handle.dispose()
    }
  }
  const pending = teardown().catch(onFailure)
  pendingTeardowns.add(pending)
  void pending.finally(() => pendingTeardowns.delete(pending))
  return pending
}

/** Settles once every refused-start teardown pending now has finished; at once when none is. Never rejects. */
export function settleStartTeardowns(): Promise<void> {
  return Promise.all(pendingTeardowns).then(() => undefined)
}
