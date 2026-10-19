import type {
  TelemetryCaptureMessage,
  TelemetryDiagnosticInput,
  TelemetryTransport,
  TelemetryTransportFactory,
} from "@oh-my-opencode/telemetry-core"

type PostHogRuntime = { readonly createDefaultPostHogTransport: TelemetryTransportFactory }
type LazyPostHogOptions = {
  readonly load?: () => Promise<PostHogRuntime>
  readonly diagnostics?: (input: TelemetryDiagnosticInput) => void
}

// One successful import per process, but a missing/broken sidecar can be retried.
let runtime: Promise<PostHogRuntime> | undefined
function loadRuntime(): Promise<PostHogRuntime> {
  runtime ??= import("#omo-telemetry-posthog-runtime").catch((error: unknown) => {
    runtime = undefined
    throw error
  })
  return runtime
}

export function createLazyPostHogTransportFactory(input: LazyPostHogOptions = {}): TelemetryTransportFactory {
  return (apiKey, options) => {
    let transport: TelemetryTransport | undefined
    let loading: Promise<TelemetryTransport | undefined> | undefined
    const queued: TelemetryCaptureMessage[] = []
    const report = (event: TelemetryDiagnosticInput["event"], error: unknown): void => {
      input.diagnostics?.({
        event, source: "omo-telemetry-posthog", error,
        errorKind: error instanceof Error ? "error" : "non_error",
      })
    }
    const forward = (target: TelemetryTransport, message: TelemetryCaptureMessage): void => {
      try {
        target.capture(message)
      } catch (error) {
        report("telemetry_capture_failed", error)
      }
    }
    const load = (): Promise<TelemetryTransport | undefined> => {
      if (transport !== undefined) return Promise.resolve(transport)
      loading ??= (async () => {
        let module: PostHogRuntime
        try {
          module = await (input.load ?? loadRuntime)()
        } catch (error) {
          report("telemetry_posthog_import_failed", error)
          return undefined
        }
        try {
          transport = module.createDefaultPostHogTransport(apiKey, options)
        } catch (error) {
          report("telemetry_posthog_init_failed", error)
          return undefined
        }
        for (const message of queued.splice(0)) forward(transport, message)
        return transport
      })().finally(() => { loading = undefined })
      return loading
    }
    return {
      capture(message) {
        if (transport !== undefined) {
          forward(transport, message)
          return
        }
        queued.push(message)
        void load()
      },
      async flush() {
        const target = await load()
        await target?.flush?.()
      },
      async shutdown() {
        const target = await load()
        await target?.shutdown()
      },
    }
  }
}
