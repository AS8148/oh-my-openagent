import { TelemetryDeliveryError, type TelemetryDiagnosticInput } from "@oh-my-opencode/telemetry-core"

import type { NativeCaptureState } from "./omo-native-summary-wiring"
import type { PublishSummary, SummaryPublication } from "./session-summary-publisher"
import type { PendingRecord, SummaryStorage } from "./session-summary-storage"

/**
 * Sends one pending event and retires its file on acknowledgment. A rejection keeps the file for a later
 * retry, unless it is a permanent `TelemetryDeliveryError` (the event itself was refused), which deletes it
 * and counts it as dropped. Ships in the recovery sidecar: only a closed window or a resend reaches it.
 */
export async function sendSummaryRecord(record: PendingRecord, context: {
  readonly storage: SummaryStorage
  readonly publish: PublishSummary
  readonly report: (event: TelemetryDiagnosticInput["event"], error: unknown) => void
  readonly countDropped: (count: number) => void
}): Promise<void> {
  try {
    if (await context.publish({ uuid: record.uuid, properties: record.properties, timestamp: record.createdAt })) context.storage.removePending(record.uuid)
  } catch (error) {
    context.report("telemetry_capture_failed", error)
    if (error instanceof TelemetryDeliveryError && error.permanent) {
      context.storage.removePending(record.uuid)
      context.countDropped(1)
    }
  }
}

// Acknowledged only when the server accepted this very event: the immediate send resolved on a 2xx answer;
// a rejected send propagates so the pending file stays. A transport without immediate sends falls back to
// its flush.
export async function publishThroughState(state: NativeCaptureState, publication: SummaryPublication): Promise<boolean> {
  const capture = state.capture
  if (capture === undefined) return false
  capture("session_summary", publication.properties, { uuid: publication.uuid, timestamp: new Date(publication.timestamp) })
  const ack = state.acks.get(publication.uuid)
  state.acks.delete(publication.uuid)
  if (!state.delivered.delete(publication.uuid)) return false
  if (ack !== undefined) await ack
  else await state.flush?.()
  return true
}
