import type { SyncEntry } from "./entry.ts"
import type { ChainEntry } from "./vendor/sync-format/chain.ts"
import { foldRefusal, type ReceiverRefusal } from "./vendor/sync-format/fold.ts"
import { receiveKeyringChain } from "./vendor/sync-format/receive.ts"

/**
 * The merged omo-service receiver (vendored sync-format), run over the client's entries so the
 * client refuses exactly what the server's reference receiver refuses (sync-design 8.2): canonical
 * member and wrap order, recovery-join author and enrolment, one veto per join, batch rows without
 * bodies, monotonic sequence, and every fork-resolution's branches and evidence proof.
 *
 * The entries cross as their wire JSON: the receiver reads the transport shape and validates
 * every field it uses itself.
 */
export const wire = (entries: ReadonlyArray<SyncEntry>): ReadonlyArray<ChainEntry> => JSON.parse(JSON.stringify(entries))

/** The receiver's refusal of `entry` appended after the already-verified keyring `history`; null when it holds. */
export const receiverRefusal = async (
  history: ReadonlyArray<SyncEntry>,
  entry: SyncEntry,
): Promise<ReceiverRefusal | null> => {
  const list = wire([...history, entry])
  const isFork = entry.kind === "keyring" && entry.body.kind === "fork-resolution"
  const received = isFork ? await receiveKeyringChain(list) : foldRefusal(list)
  return received.ok || received.seq !== entry.seq ? null : received.reason
}
