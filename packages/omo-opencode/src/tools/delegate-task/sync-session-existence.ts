import { isSessionNotFoundError } from "../../features/background-agent/session-existence"
import type { OpencodeClient } from "./types"

type SessionLookupResult = { data?: unknown; error?: unknown }

// Only a definitive not-found answer counts: a transport blip or an unknown error must not
// end a live task, so those read as "still exists" and the normal poll bounds apply.
export async function isSyncSessionDeleted(client: OpencodeClient, sessionID: string): Promise<boolean> {
  if (typeof client.session?.get !== "function") return false
  try {
    const response: SessionLookupResult = await client.session.get({ path: { id: sessionID } })
    return response.error !== undefined && response.error !== null && isSessionNotFoundError(response.error)
  } catch (error) {
    return isSessionNotFoundError(error)
  }
}

export function formatDeletedSyncSessionError(sessionID: string): string {
  return `Error: Session ${sessionID} no longer exists, so this task cannot be continued. Completed sync task sessions are deleted after background_task.taskCleanupDelayMs (default 10 minutes). Start a new task with subagent_type or category instead of passing this task_id.`
}
