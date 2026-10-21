import { agreementItemsOf, readAgreementsWorktree, renderAgreementsFile } from "../agreements/ledger-file"
import { applyAgreementRecords } from "../agreements/mutate"
import type { AgreementExtractionRecord, AgreementsPolicy } from "../agreements/types"

export async function renderAgreementsTarget(
  repoDir: string,
  records: readonly AgreementExtractionRecord[],
  policy: AgreementsPolicy,
): Promise<string> {
  const existing = await readAgreementsWorktree(repoDir)
  const { items } = applyAgreementRecords(agreementItemsOf(existing), records, policy)
  return renderAgreementsFile(existing, items)
}
