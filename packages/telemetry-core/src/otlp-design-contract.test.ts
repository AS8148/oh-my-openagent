import { afterEach, describe, expect, test } from "bun:test"

import * as otlp from "./otlp"
import type { WireAttributes } from "./otlp-config"
import type { CreateOtlpTelemetryTransportInput } from "./otlp-transport-types"
import { capture, createSpoolRoot, decodeLogs, logRecordsOf, makeTransport, recordingFetch } from "./otlp-test-support"

const roots: (() => void)[] = []
afterEach(() => {
  for (const cleanup of roots.splice(0)) cleanup()
})

function root(): string {
  const created = createSpoolRoot("telemetry-core-design-contract-")
  roots.push(created.cleanup)
  return created.dir
}

describe("the approved wire contract: the schema artifact is the allowlist and no free-text slot exists", () => {
  test("#given a LogRecord emitted with a body #then the body never reaches the wire", async () => {
    // given
    const dir = root()
    const { calls, fetch } = recordingFetch()
    const transport = makeTransport(dir, { fetch })

    // when
    transport.providers.logger.emit({
      eventName: "omo.feature_used",
      body: "free text that must never travel",
      attributes: { "omo.feature": "direct" },
    })
    await transport.flush()

    // then
    const logs = calls.filter((c) => c.url.endsWith("/v1/logs")).flatMap((c) => logRecordsOf(decodeLogs(c.body)))
    expect(logs).toHaveLength(1)
    expect(logs[0]?.body).toBeUndefined()
  })

  test("#given a projection that allowlists one property #when capture gets more #then only the allowlisted key travels", async () => {
    // given
    const dir = root()
    const { calls, fetch } = recordingFetch()
    const transport = makeTransport(dir, {
      fetch,
      project: (_event, properties): WireAttributes => {
        const feature = properties["feature"]
        return typeof feature === "string" ? { "omo.feature": feature } : {}
      },
    })

    // when
    capture(transport, "feature_used", { feature: "a", note: "not in the artifact", count: 3 })
    await transport.flush()

    // then
    const logs = calls.filter((c) => c.url.endsWith("/v1/logs")).flatMap((c) => logRecordsOf(decodeLogs(c.body)))
    expect(logs.flatMap((r) => r.attributes.map((kv) => kv.key)).filter((key) => key.startsWith("omo."))).toEqual(["omo.feature"])
  })

  test("#then the package exports no fail-open default projection and the transport input requires one", () => {
    // A transport built without the artifact's projection would ship every primitive property; the input type forbids it.
    const requiresProject: undefined extends CreateOtlpTelemetryTransportInput["project"] ? false : true = true
    expect(requiresProject).toBe(true)
    expect("defaultWireProjection" in otlp).toBe(false)
  })
})
