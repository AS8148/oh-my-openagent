import type {
  EventTelemetryCaptureOptions,
  EventTelemetryProperties,
  TelemetryDiagnosticInput,
  TelemetryEnv,
} from "@oh-my-opencode/telemetry-core"

import { loadSenpiOmoConfig } from "../config-resolution"
import { createSessionSummaryRecorder, type SessionSummaryRecorder, type SummaryPublication } from "./omo-native-session-summary"
import type { OmoNativeEventName } from "./product-identity"
import type { TelemetrySessionRole } from "./session-role"
import { currentProcessOwner } from "./session-summary-owner"
import { resolveRawTurnSampleRate } from "./session-summary-sampling"
import { createSummaryStorage } from "./session-summary-storage"

/** What the component's transport facade shares with every registration of one loaded extension. */
export type NativeCaptureState = {
  capture?: (name: OmoNativeEventName, properties: EventTelemetryProperties, options?: EventTelemetryCaptureOptions) => void
  flush?: () => Promise<void>
  sessionHash?: string
  /** Event uuids the privacy client actually handed to the transport (rejected events never get here). */
  readonly delivered: Set<string>
  onCaptureReady?: () => void
}

export const SUMMARY_SHUTDOWN_WAIT_MS = 1_000

export function createNativeSummaryRecorder(input: {
  readonly state: NativeCaptureState
  readonly stateDir: string
  readonly env: TelemetryEnv
  readonly cwd: string | undefined
  readonly sessionRole: TelemetrySessionRole
  readonly rawTurnSampleRate?: number
  readonly isPidAlive?: (pid: number) => boolean
  readonly diagnostics?: (input: TelemetryDiagnosticInput) => void
}): SessionSummaryRecorder {
  const { state, env } = input
  let sampleRate = input.rawTurnSampleRate
  const summary = createSessionSummaryRecorder({
    storage: createSummaryStorage({
      stateDir: input.stateDir,
      owner: currentProcessOwner(),
      ...(input.isPidAlive === undefined ? {} : { isPidAlive: input.isPidAlive }),
    }),
    publish: (publication) => publishThroughState(state, publication),
    sessionRole: input.sessionRole,
    // The sink is fixed to PostHog until `telemetry.sink` exists; the collector sink forces 1.
    sampleRate: () => (sampleRate ??= resolveRawTurnSampleRate({ sink: "posthog", configured: configuredSampleRate(input.cwd, env), env })),
    ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics }),
  })
  state.onCaptureReady = () => {
    void summary.recover()
  }
  return summary
}

// Acknowledged only when the event reached the transport AND the transport's flush resolved.
async function publishThroughState(state: NativeCaptureState, publication: SummaryPublication): Promise<boolean> {
  const capture = state.capture
  if (capture === undefined) return false
  capture("session_summary", publication.properties, { uuid: publication.uuid, timestamp: new Date(publication.timestamp) })
  if (!state.delivered.delete(publication.uuid)) return false
  await state.flush?.()
  return true
}

// `telemetry.rawTurnSampleRate` from omo.json; an unreadable config leaves the documented default.
function configuredSampleRate(cwd: string | undefined, env: TelemetryEnv): number | undefined {
  try {
    return loadSenpiOmoConfig({ env: { ...env }, ...(cwd === undefined ? {} : { cwd }) }).config.telemetry?.rawTurnSampleRate
  } catch {
    return undefined
  }
}

export async function settleWithin(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([work, new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
  })])
  clearTimeout(timer)
}
