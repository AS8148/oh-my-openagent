import { renderClaimReceipt, type ClaimReceipt } from "../provenance"

export function factDisplayText(record: { readonly text: string; readonly receipt?: ClaimReceipt }): string {
  return record.receipt === undefined ? record.text : `${record.text} (source: ${renderClaimReceipt(record.receipt)})`
}
