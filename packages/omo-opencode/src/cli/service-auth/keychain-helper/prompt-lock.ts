import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { publishLockRecord } from "@oh-my-opencode/team-core/team-state-store/lock-publish"
import { buildLockRecord, markLockRecordReleased } from "@oh-my-opencode/team-core/team-state-store/lock-record"
import { reapStaleLock } from "@oh-my-opencode/team-core/team-state-store/locks"
import { removeLockRecordIfUnchanged } from "@oh-my-opencode/team-core/team-state-store/lock-reclaim"
import { keychainProcessState } from "./process-state"

/**
 * R4 (design 3.6): the machine-wide prompt lock around `approve`, taken with zero wait. Null means another process is
 * already showing the one dialog, so this caller must not open a second. A pending `approve` keeps holding it; a holder
 * that died leaves a record that is stale at once and is reaped by the next taker.
 */
export function promptLockAt(path: string): () => Promise<(() => Promise<void>) | null> {
  return async () => {
    // Another bundled copy in this same process may hold it: its record carries this pid with a different instance id,
    // which the cross-process reaper would read as stale, so the process-wide set is checked first.
    const held = keychainProcessState().heldPromptLocks
    if (held.has(path)) return null
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    for (let attempt = 0; attempt < 2; attempt++) {
      const record = buildLockRecord("keychain-prompt")
      if (await publishLockRecord(path, record)) {
        held.add(path)
        return async () => {
          markLockRecordReleased(record)
          held.delete(path)
          await removeLockRecordIfUnchanged(path, record, Number.POSITIVE_INFINITY)
        }
      }
      if ((await reapStaleLock(path, Number.POSITIVE_INFINITY)) !== "removed") return null
    }
    return null
  }
}
