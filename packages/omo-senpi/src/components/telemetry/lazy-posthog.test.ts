import { expect, it } from "bun:test"
import type { TelemetryCaptureMessage, TelemetryTransport, TelemetryDiagnosticInput } from "@oh-my-opencode/telemetry-core"
import { createLazyPostHogTransportFactory } from "./lazy-posthog"

const options = {
  host: "https://posthog.test", disableGeoip: false, enableExceptionAutocapture: false,
  enableLocalEvaluation: false, strictLocalEvaluation: true, disableRemoteConfig: true,
  flushAt: 20, flushInterval: 10_000,
}
const message = (event: string): TelemetryCaptureMessage => ({ distinctId: "test", event, properties: { ordinal: event } })

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("uninitialized deferred") }
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

for (const method of ["flush", "shutdown"] as const) {
  it(`buffers captures in order and awaits the sidecar before ${method}`, async () => {
    // Given a pending runtime and a recorded transport.
    const load = deferred<{ createDefaultPostHogTransport: () => TelemetryTransport }>()
    const calls: unknown[] = []
    let loads = 0
    const factory = createLazyPostHogTransportFactory({ load: () => { loads++; return load.promise } })
    const transport = factory("key", options)
    expect(loads).toBe(0)
    // When captures and a lifecycle operation arrive before import completion.
    transport.capture(message("first"))
    transport.capture(message("second"))
    let finished = false
    const pending = transport[method]?.().then(() => { finished = true })
    expect(finished).toBe(false)
    expect(calls).toEqual([])
    load.resolve({ createDefaultPostHogTransport: () => ({
      capture: (value) => { calls.push(value) },
      flush: async () => { calls.push("flush") },
      shutdown: async () => { calls.push("shutdown") },
    }) })
    await pending
    // Then the original payloads precede the lifecycle call exactly once.
    expect(loads).toBe(1)
    expect(calls).toEqual([message("first"), message("second"), method])
    transport.capture(message("third"))
    expect(calls.at(-1)).toEqual(message("third"))
  })
}

it("reports a failed import without throwing and retries on the next call", async () => {
  // Given a loader that fails once.
  const diagnostics: TelemetryDiagnosticInput[] = []
  const captured: TelemetryCaptureMessage[] = []
  let attempts = 0
  const transport = createLazyPostHogTransportFactory({
    diagnostics: (value) => { diagnostics.push(value) },
    load: async () => {
      if (++attempts === 1) throw new Error("missing sidecar")
      return { createDefaultPostHogTransport: () => ({
        capture: (value: TelemetryCaptureMessage) => { captured.push(value) },
        shutdown: async () => undefined,
      }) }
    },
  })("key", options)
  // When import fails, then flush resolves and reports the existing diagnostic.
  transport.capture(message("first"))
  await transport.flush?.()
  expect(diagnostics.map(value => value.event)).toEqual(["telemetry_posthog_import_failed"])
  expect(captured).toEqual([])
  // When another call retries, then all queued messages retain their order.
  transport.capture(message("second"))
  await transport.shutdown()
  expect(attempts).toBe(2)
  expect(captured).toEqual([message("first"), message("second")])
})
