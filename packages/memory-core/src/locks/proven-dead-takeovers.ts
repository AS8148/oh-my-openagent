import type { LockRecord } from "./lock-record"

// In-process evidence of dead-owner takeovers, keyed by lock path. The lock protocol is the only
// component that can prove a previous owner died (pid + start identity, see stale-owner.ts), and
// that proof exists at takeover time, in the process that performed it - the lock file itself is
// overwritten by the new holder, so the dead owner's record would otherwise be unrecoverable by
// the time a later consumer (the stranded-git-lock sweep) needs to justify reclamation.
const provenDeadTakeovers = new Map<string, LockRecord>()

export function recordProvenDeadTakeover(lockPath: string, previousOwner: LockRecord): void {
  provenDeadTakeovers.set(lockPath, previousOwner)
}

export function provenDeadTakeoverFor(lockPath: string): LockRecord | undefined {
  return provenDeadTakeovers.get(lockPath)
}
