import { linkSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { listNames, readJsonOrCorrupt } from "./session-summary-files"
import { createOwnerLiveness } from "./session-summary-liveness"
import { parseOwner, type ProcessOwner } from "./session-summary-owner"
import {
  claimFile,
  parsePendingRecord,
  parseRead,
  type Claimed,
  type PendingRecord,
  type ReadResult,
  type SummaryStorage,
  type WindowRecord,
} from "./session-summary-storage"

export type Leftover = { readonly path: string; readonly owner: ProcessOwner; readonly kind: "temp" | "window-claim" | "pending-claim" }

/** The storage operations only recovery uses; they ship in the recovery sidecar, not the entry bundle. */
export type RecoveryStorage = SummaryStorage & {
  readonly isOwnerAlive: (owner: ProcessOwner) => boolean
  /** A key one process wrote beside another process's window; nobody continues it once its writer is gone. */
  readonly isOwnCopyKey: (key: string) => boolean
  /** Exclusive create: never replaces a window another process wrote in the meantime. */
  readonly createWindow: (key: string, record: WindowRecord) => boolean
  readonly readPending: (uuid: string) => ReadResult<PendingRecord>
  readonly claimPending: (uuid: string) => Claimed<ReadResult<PendingRecord>> | undefined
  readonly leftovers: () => readonly Leftover[]
}

const TEMP_FILE = /^.+\.(\d+)-([A-Za-z0-9-]{1,64})\.tmp$/
const CLAIM_FILE = /^.+\.claimed-(\d+)-([A-Za-z0-9-]{1,64})$/

export function withRecoveryOps(storage: SummaryStorage): RecoveryStorage {
  const { dir, owner } = storage
  const pendingDir = join(dir, "pending")
  const windowPath = (key: string) => join(dir, `${key}.json`)
  const pendingPath = (uuid: string) => join(pendingDir, `${uuid}.json`)
  return {
    ...storage,
    isOwnerAlive: createOwnerLiveness({ dir, owner, now: storage.now, ...storage.probes }),
    isOwnCopyKey: (key) => key.includes("@"),
    createWindow(key, record) {
      storage.register()
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const temp = `${windowPath(key)}.${owner.pid}-${owner.bootId}.tmp`
      writeFileSync(temp, JSON.stringify({ v: 2, ...record }), { mode: 0o600 })
      try {
        linkSync(temp, windowPath(key))
        return true
      } catch {
        return false
      } finally {
        unlinkSync(temp)
      }
    },
    readPending: (uuid) => parseRead(readJsonOrCorrupt(pendingPath(uuid)), parsePendingRecord),
    claimPending: (uuid) => claimFile(pendingPath(uuid), owner, parsePendingRecord),
    leftovers: () => [
      ...collectLeftovers(dir, "window-claim"),
      ...collectLeftovers(pendingDir, "pending-claim"),
    ],
  }
}

function collectLeftovers(dir: string, claimKind: "window-claim" | "pending-claim"): Leftover[] {
  return listNames(dir).flatMap((name): Leftover[] => {
    const claimMatch = CLAIM_FILE.exec(name)
    const match = claimMatch ?? TEMP_FILE.exec(name)
    const owner = match === null ? undefined : parseOwner({ pid: Number(match[1]), bootId: match[2] })
    if (owner === undefined) return []
    return [{ path: join(dir, name), owner, kind: claimMatch === null ? "temp" : claimKind }]
  })
}
