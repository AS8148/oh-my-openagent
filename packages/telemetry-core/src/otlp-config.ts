import { shouldDisableTelemetry } from "./env"
import type { TelemetryEnv } from "./types"

export const DEFAULT_OTLP_ENDPOINT = "https://t.omo.dev"

/**
 * `OMO_TELEMETRY_ENDPOINT` overrides the configured endpoint. The standard `OTEL_EXPORTER_OTLP_*`
 * variables are deliberately never read: a machine-wide OpenTelemetry setup must not redirect
 * product telemetry (D-H).
 */
export function resolveOtlpEndpoint(env: TelemetryEnv, configured?: string): string {
  const override = env["OMO_TELEMETRY_ENDPOINT"]?.trim()
  const base = override !== undefined && override.length > 0 ? override : configured ?? DEFAULT_OTLP_ENDPOINT
  return base.replace(/\/+$/, "")
}

export function isOtlpTelemetryEnabled(input: { readonly env: TelemetryEnv; readonly productEnvPrefix: string }): boolean {
  if (input.env["OTEL_SDK_DISABLED"]?.trim().toLowerCase() === "true") return false
  return !shouldDisableTelemetry({ env: input.env, productEnvPrefix: input.productEnvPrefix })
}

export type WireAttributes = Record<string, string | number | boolean>
export type OtlpWireProjection = (event: string, properties: Readonly<Record<string, unknown>>) => WireAttributes

const RESOURCE_OR_RELAY_KEYS = new Set([
  "$os",
  "$os_version",
  "$process_person_profile",
  "$session_id",
  "ci",
  "event_id",
  "install_hash",
  "package_version",
  "platform",
  "product_name",
  "schema_version",
  "surface",
])

/**
 * The default D-P key rule for an allowlisted bag: Resource-level and relay-only keys stay off the
 * record, `$` keys never travel on the OTLP wire, every other key becomes `omo.<bare name>`. A
 * product passes its artifact projection instead to map the semantic-convention keys.
 */
export const defaultWireProjection: OtlpWireProjection = (_event, properties) => {
  const attributes: WireAttributes = {}
  for (const [key, value] of Object.entries(properties)) {
    if (RESOURCE_OR_RELAY_KEYS.has(key) || key.startsWith("$")) continue
    if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
      attributes[`omo.${key}`] = value
    }
  }
  return attributes
}
