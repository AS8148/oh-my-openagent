import { renderClaimReceipt, type ClaimReceipt } from "../provenance"

const RECEIPT_SUFFIX = / \(source: [^\n]*\)$/

export function factDisplayText(record: { readonly text: string; readonly receipt?: ClaimReceipt }): string {
  const text = record.text.replace(RECEIPT_SUFFIX, "")
  return record.receipt === undefined ? text : `${text} (source: ${renderClaimReceipt(record.receipt)})`
}

export function stripReceiptSuffix(content: string): string {
  return content.replace(RECEIPT_SUFFIX, "")
}
