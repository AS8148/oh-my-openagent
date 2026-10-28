import { randomUUID } from "node:crypto"
import { open, readFile, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"

/** The lock record changed while it was handed to another process: the critical section must stop writing. */
export class LockLeaseLostError extends Error {
  constructor(lockPath: string) {
    super(`The lock at ${lockPath} changed while it was handed over; the critical section was aborted.`)
    this.name = "LockLeaseLostError"
  }
}

/**
 * Hands a held lock to a child process for the duration of one call and takes it back (#11262 design 3.6, R2).
 *
 * `handOver(pid)` atomically replaces this process's record with one naming `pid` and a fresh instance id, so every
 * version of the lock treats the child as the live holder: no other process can acquire the lock while the child lives,
 * even if this process dies. When the child exits without a `restore`, its 4-line record is stale at once.
 *
 * `restore()` is compare-and-restore: only if the path still holds exactly the record `handOver` wrote does the original
 * record go back; otherwise the lock was lost and `LockLeaseLostError` is thrown. Both steps are renames over the lock
 * path, never unlink-and-create: an exclusive create is what grants the lock, so a gap would let a contender in.
 */
export type LockLease = {
  readonly handOver: (pid: number) => Promise<void>
  readonly restore: () => Promise<void>
}

async function replaceRecord(lockPath: string, content: string): Promise<void> {
  const temporary = join(dirname(lockPath), `.${randomUUID()}.lease`)
  try {
    const handle = await open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(content)
    } finally {
      await handle.close()
    }
    await rename(temporary, lockPath)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function currentRecord(lockPath: string): Promise<string | null> {
  try {
    return await readFile(lockPath, "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null
    throw error
  }
}

export function createLockLease(lockPath: string, ownerRecord: string, ownerTag: string): LockLease {
  let handedTo: string | null = null
  return {
    async handOver(pid) {
      if (handedTo !== null) throw new Error("The lock is already handed over; restore it first.")
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Cannot hand the lock to pid ${pid}.`)
      if ((await currentRecord(lockPath)) !== ownerRecord) throw new LockLeaseLostError(lockPath)
      const record = `${ownerTag} ${randomUUID()}\n${pid}\n${Date.now()}\n${randomUUID()}\n`
      await replaceRecord(lockPath, record)
      handedTo = record
    },
    async restore() {
      if (handedTo === null) throw new Error("The lock is not handed over.")
      const expected = handedTo
      handedTo = null
      if ((await currentRecord(lockPath)) !== expected) throw new LockLeaseLostError(lockPath)
      await replaceRecord(lockPath, ownerRecord)
    },
  }
}
