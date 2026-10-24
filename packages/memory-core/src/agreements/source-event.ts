import { createHash } from "node:crypto"
import type { AgreementExtractionRecord } from "./types"

const RECEIPT = /^<!-- agreement-event: ([0-9a-f]{64}) -->$/

export function agreementEventId(record: AgreementExtractionRecord, agreement: string): string | undefined {
  return record.source === undefined ? undefined : createHash("sha256")
    .update(JSON.stringify([record.source.sessionId, record.source.messageId, agreement]))
    .digest("hex")
}

export function readAgreementEvents(lines: readonly string[]): readonly string[] {
  return lines.flatMap((line) => {
    const match = RECEIPT.exec(line)
    return match?.[1] === undefined ? [] : [match[1]]
  })
}

export function renderAgreementEvent(id: string): string {
  return `<!-- agreement-event: ${id} -->`
}
