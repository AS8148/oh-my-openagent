import { agreementItemsOf, readAgreementsWorktree, renderAgreementsFile } from "../agreements/ledger-file"
import { applyAgreementRecords, type AgreementEvent } from "../agreements/mutate"
import type { AgreementExtractionRecord, AgreementsPolicy } from "../agreements/types"
import { parseAgreementsLedger } from "../agreements/format"
import { readAgreementEvents } from "../agreements/source-event"
import { parseMemoryFile } from "../memfs"

export interface AgreementsTarget {
  /** The rendered ledger, or undefined when the records leave it byte-identical (stale reaffirms, refusals). */
  readonly content: string | undefined
  readonly events: readonly AgreementEvent[]
}

export async function renderAgreementsTarget(
  repoDir: string,
  records: readonly AgreementExtractionRecord[],
  policy: AgreementsPolicy,
): Promise<AgreementsTarget> {
  const existing = await readAgreementsWorktree(repoDir)
  if (records.some((record) => record.source === undefined)) {
    throw new TypeError("Agreement extraction lacks a source event; re-extract the queued transcript")
  }
  const prior = existing === undefined ? [] : readAgreementEvents(parseAgreementsLedger(parseMemoryFile(existing).body).unparsed)
  const { items, events, recordedEvents } = applyAgreementRecords(agreementItemsOf(existing), records, policy, prior)
  const content = renderAgreementsFile(existing, items, recordedEvents)
  return { content: content === existing ? undefined : content, events }
}
