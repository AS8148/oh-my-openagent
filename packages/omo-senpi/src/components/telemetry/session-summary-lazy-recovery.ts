import type { TelemetryDiagnosticInput } from "@oh-my-opencode/telemetry-core"

import type { SummaryPublisher } from "./session-summary-publisher"
import type { SummaryRecovery, createSummaryRecovery } from "./session-summary-recovery"
import type { ConsentScope, SummaryStorage } from "./session-summary-storage"

export type LoadSummaryRecovery = () => Promise<{ readonly createSummaryRecovery: typeof createSummaryRecovery }>

export type LazySummaryRecovery = {
  readonly sweep: () => Promise<void> | undefined
}

// The sweep ships as `extensions/omo-telemetry-recovery.js`: a directory holding only this process's own
// windows and in-flight events has nothing a sweep would touch, so the common startup never loads it.
export function createLazySummaryRecovery(input: {
  readonly storage: SummaryStorage
  readonly publisher: SummaryPublisher
  readonly isScopeConsented: (scope: ConsentScope) => boolean
  readonly diagnostics?: (input: TelemetryDiagnosticInput) => void
  readonly ownWindowKeys: () => Iterable<string>
  readonly load?: LoadSummaryRecovery
}): LazySummaryRecovery {
  const { storage, publisher } = input
  const load = input.load ?? (() => import("#omo-telemetry-recovery-runtime"))
  let recovery: SummaryRecovery | undefined
  let loading: Promise<SummaryRecovery> | undefined

  const hasWork = (): boolean => {
    if (storage.leftovers().length > 0) return true
    if (storage.pendingUuids().some((uuid) => !publisher.isInFlight(uuid))) return true
    const own = new Set(input.ownWindowKeys())
    return storage.windowKeys().some((key) => !own.has(key))
  }

  return {
    sweep() {
      if (recovery !== undefined) {
        recovery.sweep()
        return undefined
      }
      if (!hasWork()) return undefined
      loading ??= load().then(
        ({ createSummaryRecovery }) => (recovery = createSummaryRecovery({
          storage,
          publisher,
          isScopeConsented: input.isScopeConsented,
          ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics }),
        })),
        (error: unknown) => {
          loading = undefined
          throw error
        },
      )
      return loading.then((loaded) => loaded.sweep())
    },
  }
}
