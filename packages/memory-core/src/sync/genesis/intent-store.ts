import { createHash, randomBytes } from "node:crypto"
import { dirname, join } from "node:path"
import { mkdir, readFile, rename, rm, stat, writeFile } from "../../fs/resilient.ts"
import { syncJournalDirectory, syncJournalFile } from "../../journal/fsync.ts"
import { withLock } from "../../locks/acquire.ts"
import { createLockRecord } from "../../locks/lock-record.ts"
import { checkSyncOperation, dispatchSyncEffect, type SyncOperationAuthority } from "../operation.ts"
import type { DeviceKeyring } from "../keyring-port.ts"
import { GenesisEnableError } from "./bridge.ts"
import { type GenesisIntent, parseGenesisIntent } from "./intent-verify.ts"

type IntentOwner = {
  readonly account: string
  readonly serviceOrigin?: string
  readonly serviceDeviceId: string
  readonly keyring: DeviceKeyring
  readonly pinDir: string
  readonly operation?: SyncOperationAuthority
}
const location = (owner: IntentOwner): string => join(owner.pinDir, "genesis-intent",
  createHash("sha256").update(JSON.stringify([owner.account, owner.keyring.principal().id])).digest("hex"))
const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT"

/** One account/principal ceremony across CLI and engine processes, including native preparation. */
export const withGenesisLock = async <T>(owner: IntentOwner, run: () => Promise<T>): Promise<T> => {
  const target = location(owner)
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  return withLock(`${target}.lock`, await createLockRecord("sync-genesis"), run,
    owner.operation === undefined ? {} : { signal: owner.operation.signal })
}

export const loadGenesisIntent = async (owner: IntentOwner): Promise<GenesisIntent | null> => {
  const target = location(owner)
  let raw: string
  try {
    raw = await readFile(join(target, "intent.json"), "utf8")
  } catch (error) {
    if (!missing(error)) throw error
    try { await stat(target) } catch (dirError) {
      if (missing(dirError)) return null
      throw dirError
    }
    throw new GenesisEnableError("corrupt_intent")
  }
  return parseGenesisIntent(raw, owner)
}

/** Public, exact signed request. Publishing a nonempty directory cannot overwrite another intent. */
export const storeGenesisIntent = async (owner: IntentOwner, intent: GenesisIntent): Promise<void> => {
  const target = location(owner)
  const staging = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  await mkdir(staging, { mode: 0o700 })
  try {
    await writeFile(join(staging, "intent.json"), JSON.stringify(intent), { flag: "wx", mode: 0o600 })
    await syncJournalFile(join(staging, "intent.json"))
    await syncJournalDirectory(staging)
    await rename(staging, target, (begin) => dispatchSyncEffect(owner.operation, begin))
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  // Publication is irreversible: finish durability and readback even after owner retirement.
  await syncJournalDirectory(dirname(target))
  const written = await loadGenesisIntent(owner)
  if (written === null || written.genesisDigest !== intent.genesisDigest) throw new GenesisEnableError("corrupt_intent")
  await checkSyncOperation(owner.operation)
}

export const retireGenesisIntent = async (owner: IntentOwner): Promise<void> => {
  const target = location(owner)
  const retired = `${target}.retired-${randomBytes(6).toString("hex")}`
  await rename(target, retired, (begin) => dispatchSyncEffect(owner.operation, begin))
  await rm(retired, { recursive: true })
  await syncJournalDirectory(dirname(target))
  await checkSyncOperation(owner.operation)
}
