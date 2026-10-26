import { randomBytes } from "node:crypto"
import { arch, platform, release } from "node:os"
import { join } from "node:path"
import {
  createOtlpTelemetryTransport,
} from "@oh-my-opencode/telemetry-core/otlp"
import type {
  TelemetryCaptureMessage, TelemetryDiagnosticInput, TelemetryEnv,
  TelemetryTransport, TelemetryTransportFactory,
} from "@oh-my-opencode/telemetry-core"
import { resolveAgentHome } from "../agent-home/resolve-agent-home"
import { createLazyPostHogTransportFactory } from "./lazy-posthog"
import { isOtlpEvent, OTLP_SPANS, projectOtlpEvent } from "./otlp-projection"

declare const OMO_TELEMETRY_INGEST_KEY: string

type TransportInput = {
  readonly env: TelemetryEnv
  readonly consent: () => boolean
  readonly diagnostics?: (input: TelemetryDiagnosticInput) => void
  readonly source?: string
}

export function createSenpiTelemetryTransportFactory(input: TransportInput): TelemetryTransportFactory {
  return createLazyPostHogTransportFactory({
    ...input,
    loadOtlp: resolveIngestKey(input.env).length === 0 ? undefined : message => createSenpiOtlpTransport(input, message),
  })
}

function resolveIngestKey(env: TelemetryEnv): string {
  return (env["OMO_TELEMETRY_INGEST_KEY"]
    ?? (typeof OMO_TELEMETRY_INGEST_KEY === "string" ? OMO_TELEMETRY_INGEST_KEY : "")).trim()
}

/** No key means no collector sender, spool or network activity; PostHog is independent. */
export async function createSenpiOtlpTransport(
  input: TransportInput,
  message: TelemetryCaptureMessage,
): Promise<TelemetryTransport | null> {
  const ingestKey = resolveIngestKey(input.env)
  if (ingestKey.length === 0 || !isOtlpEvent(message.event)) return null
  const properties = message.properties ?? {}
  const version = typeof properties["package_version"] === "string" ? properties["package_version"] : "0.0.0"
  const os = platform()
  const machineArch = arch()
  const spoolRoot = resolveAgentHome({ env: input.env })
  const transport = await createOtlpTelemetryTransport({
    productEnvPrefix: "OMO_SENPI",
    ingestKey,
    spoolRoot,
    spoolDir: join(spoolRoot, "omo-senpi", "otlp"),
    env: input.env,
    consent: input.consent,
    diagnostics: input.diagnostics,
    source: input.source,
    project: projectOtlpEvent,
    spans: OTLP_SPANS,
    resource: {
      "service.name": "omo-senpi",
      "service.version": version,
      "service.instance.id": randomBytes(16).toString("hex"),
      "omo.install.hash": message.distinctId,
      "omo.schema.version": 4,
      "omo.surface": properties["surface"] === "desktop" ? "desktop" : "cli",
      "omo.ci": properties["ci"] === true,
      "os.type": os === "win32" ? "windows" : os,
      "os.version": release().match(/^\d+(?:\.\d+){1,3}/u)?.[0] ?? "0.0",
      "host.arch": ({ x64: "amd64", arm64: "arm64", ia32: "x86", arm: "arm32" } as Readonly<Record<string, string>>)[machineArch] ?? "other",
      "telemetry.sdk.name": "omo-otel-minimal",
      "telemetry.sdk.language": "nodejs",
      "telemetry.sdk.version": "1.0.0",
    },
    scope: { name: "omo-senpi", version },
    shutdownTimeoutMs: 500,
  })
  if (transport === null) return null
  return {
    ...transport,
    capture(value) {
      if (isOtlpEvent(value.event)) transport.capture(value)
    },
  }
}
