import { renderClaimReceipt, type ClaimReceipt } from "../provenance"

const RECEIPT_MARKER = /\s*\(source: [^()\n]*(?:\([^()\n]*\)[^()\n]*)*\)/g

export function factDisplayText(record: { readonly text: string; readonly receipt?: ClaimReceipt }): string {
  const text = stripReceiptSuffix(record.text)
  return record.receipt === undefined ? text : `${text} (source: ${renderClaimReceipt(record.receipt)})`
}

export function stripReceiptSuffix(content: string): string {
  return content.replace(RECEIPT_MARKER, "").trim()
}
