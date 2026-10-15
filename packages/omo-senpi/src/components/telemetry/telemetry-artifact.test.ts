import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

import {
  CATEGORY_VALUE_PATTERN,
  CRASH_VERSION_PATTERN,
  OS_VERSION_PATTERN,
  PROVIDERS_PATTERN,
  TIMEZONE_PATTERN,
} from "./event-schema-constraints"
import { OMO_NATIVE_EVENT_SCHEMAS } from "./event-schemas"
import { KNOWN_PROVIDERS } from "./model-vocabulary"
import {
  artifactFileName,
  artifactSha256,
  buildTelemetryArtifacts,
  canonicalJson,
  serializeArtifact,
  type ArtifactAttribute,
  type TelemetryArtifact,
} from "./telemetry-artifact"

const REGISTRY = new URL("./schema-registry/", import.meta.url)
const SCHEMA: {
  readonly required: readonly string[]
  readonly $defs: {
    readonly keyPattern: { readonly pattern: string }
    readonly forbiddenKeys: { readonly enum: readonly string[] }
    readonly forbiddenKeyPatterns: { readonly anyOf: readonly { readonly pattern: string }[] }
  }
  readonly properties: { readonly resource: { readonly required: readonly string[] } }
} = JSON.parse(readFileSync(new URL("artifact.schema.json", REGISTRY), "utf8"))
const PINS: { readonly files: Readonly<Record<string, string>> } = JSON.parse(readFileSync(new URL("PINS.json", REGISTRY), "utf8"))
const KEY_PATTERN = new RegExp(SCHEMA.$defs.keyPattern.pattern, "u")
const FORBIDDEN_PATTERNS = SCHEMA.$defs.forbiddenKeyPatterns.anyOf.map(({ pattern }) => new RegExp(pattern, "u"))
const isForbidden = (key: string): boolean =>
  SCHEMA.$defs.forbiddenKeys.enum.includes(key) || FORBIDDEN_PATTERNS.some((pattern) => pattern.test(key))

const ARTIFACTS = buildTelemetryArtifacts()
const SENPI = ARTIFACTS.find(({ product }) => product === "omo-senpi") as TelemetryArtifact
const CLOUD = ARTIFACTS.find(({ product }) => product === "omo-cloud") as TelemetryArtifact

function* attributesOf(artifact: TelemetryArtifact): Generator<[string, string, ArtifactAttribute]> {
  for (const [key, spec] of Object.entries(artifact.resource)) yield ["resource", key, spec]
  for (const [event, attributes] of Object.entries(artifact.events)) {
    for (const [key, spec] of Object.entries(attributes)) yield [event, key, spec]
  }
  for (const [span, attributes] of Object.entries(artifact.spans)) {
    for (const [key, spec] of Object.entries(attributes)) yield [span, key, spec]
  }
}

function matches(pattern: string, value: string): boolean {
  return new RegExp(pattern, "u").test(value)
}

describe("telemetry schema artifacts", () => {
  test("#given the event schemas #when the artifacts are generated #then the committed files are byte exact (drift gate)", () => {
    const published = new URL("../../../plugin/", import.meta.url)
    for (const artifact of ARTIFACTS) {
      for (const directory of [new URL("./", import.meta.url), published]) {
        const file = new URL(artifactFileName(artifact.product), directory)
        if (readFileSync(file, "utf8") !== serializeArtifact(artifact)) {
          throw new Error(`${file.pathname} drifted; run bun packages/omo-senpi/scripts/telemetry-schema-artifact.ts`)
        }
      }
    }
  })

  test("#then each committed sha256 is the sha256 of its canonical body", () => {
    for (const artifact of ARTIFACTS) {
      const committed: Record<string, unknown> = JSON.parse(
        readFileSync(new URL(artifactFileName(artifact.product), import.meta.url), "utf8"),
      )
      const { sha256, ...body } = committed
      expect(sha256).toBe(createHash("sha256").update(canonicalJson(body)).digest("hex"))
      expect(artifactSha256(committed)).toBe(String(sha256))
    }
  })

  test("#then the vendored registry files match the collector's pinned hashes and the artifacts record that pin", () => {
    for (const [file, pinned] of Object.entries(PINS.files)) {
      expect(createHash("sha256").update(readFileSync(new URL(file, REGISTRY))).digest("hex")).toBe(pinned)
    }
    for (const artifact of ARTIFACTS) expect(artifact.semconv_map_sha256).toBe(PINS.files["semconv-map.json"])
  })

  test("#then two products are published: omo-senpi (install identity, relayed) and omo-cloud (identity none, never relayed)", () => {
    expect(ARTIFACTS.map(({ product, identity, relay }) => ({ product, identity, relay }))).toEqual([
      { product: "omo-senpi", identity: "install", relay: true },
      { product: "omo-cloud", identity: "none", relay: false },
    ])
    expect(SENPI.resource["omo.install.hash"]?.required).toBe(true)
    expect(CLOUD.resource["omo.install.hash"]).toBeUndefined()
    expect(CLOUD.resource["omo.surface"]?.values).toEqual(["cloud"])
    expect(Object.keys(CLOUD.events)).toEqual(Object.keys(SENPI.events))
  })

  test("#then every top-level field artifact.schema.json requires is present", () => {
    for (const artifact of ARTIFACTS) {
      for (const field of SCHEMA.required) expect(Object.hasOwn(artifact, field)).toBe(true)
      for (const key of SCHEMA.properties.resource.required) expect(artifact.resource[key]).toBeDefined()
    }
  })

  test("#then no string lacks values|pattern and no number lacks bounds", () => {
    const violations: string[] = []
    for (const artifact of ARTIFACTS) {
      for (const [owner, key, spec] of attributesOf(artifact)) {
        if (spec.type === "string" && spec.values === undefined && spec.pattern === undefined) violations.push(`${owner}.${key}`)
        if (spec.type === "number" && (spec.min === undefined || spec.max === undefined)) violations.push(`${owner}.${key}`)
      }
    }
    expect(violations).toEqual([])
  })

  test("#then every pattern compiles, is anchored, and no string pattern is a character class that admits paths or prose", () => {
    const patterns = new Set<string>([SENPI.scope.version])
    for (const artifact of ARTIFACTS) {
      for (const [, , spec] of attributesOf(artifact)) if (spec.pattern !== undefined) patterns.add(spec.pattern)
    }
    for (const pattern of patterns) {
      expect(pattern.startsWith("^") && pattern.endsWith("$")).toBe(true)
      expect(() => new RegExp(pattern, "u")).not.toThrow()
      const characterClass = /^\^\[([^\]]+)\](?:\{\d+(?:,\d*)?\}|[+*])\$$/u.exec(pattern)?.[1]
      expect(characterClass !== undefined && /[/@ ]|\\s/u.test(characterClass)).toBe(false)
    }
  })

  test("#then every wire key matches the key pattern and none is forbidden", () => {
    for (const artifact of ARTIFACTS) {
      for (const [owner, key] of attributesOf(artifact)) {
        expect(`${owner}.${key} ${KEY_PATTERN.test(key)}`).toBe(`${owner}.${key} true`)
        expect(`${owner}.${key} ${isForbidden(key)}`).toBe(`${owner}.${key} false`)
      }
    }
  })

  test("#then mapped fields use their semantic-convention keys and everything else is omo.<bare name>", () => {
    const turn = SENPI.events["omo.turn_completed"] ?? {}
    expect(Object.keys(turn)).toEqual(expect.arrayContaining([
      "log.record.uid", "session.id", "omo.session.role", "omo.provider", "gen_ai.provider.name", "omo.model_id",
      "gen_ai.usage.input_tokens", "gen_ai.usage.cache_read.input_tokens", "gen_ai.usage.cache_creation.input_tokens",
      "gen_ai.usage.output_tokens", "gen_ai.usage.reasoning.output_tokens", "omo.usage.total_tokens", "omo.cost.usd_1e4",
      "omo.turn.index", "omo.sample_rate", "omo.machine_hash", "gen_ai.request.model", "gen_ai.response.model",
    ]))
    expect(turn).not.toHaveProperty(["omo.cost_usd"])
    expect(SENPI.derived_properties["omo.turn_completed"]).toEqual({ cost_usd: { from: "omo.cost.usd_1e4", divide_by: 10_000 } })
    expect(SENPI.events["omo.category_config"]).toHaveProperty(["omo.cat_quick"])
    expect(SENPI.events["omo.session_started"]).toHaveProperty(["omo.providers"])
    expect(SENPI.events["omo.session_started"]).not.toHaveProperty(["omo.arch"])
    expect(SENPI.resource_projections["omo.session_started"]).toEqual({ $os: "os.type", $os_version: "os.version", arch: "host.arch" })
    expect(SENPI.events["omo.process_crashed"]).toHaveProperty(["process.exit.code"])
    expect(SENPI.events["omo.session_summary"]).toHaveProperty(["omo.input_tokens"])
    // `omo.is_real_user_prompt` would hit the forbidden `_prompt` suffix rule: the map renames it.
    expect(SENPI.events["omo.prompt_submitted"]?.["omo.prompt.is_real_user"]?.posthog_name).toBe("is_real_user_prompt")
    for (const attributes of Object.values(SENPI.events)) {
      for (const [key, spec] of Object.entries(attributes)) {
        if (spec.posthog_name !== undefined && key.startsWith("omo.") && !key.includes(".", 4)) {
          expect(key).toBe(`omo.${spec.posthog_name}`)
        }
      }
    }
  })

  test("#then turn_completed requires every attribute but the optional GenAI model ids, and session.id is required everywhere except sessionless events", () => {
    const turn = SENPI.events["omo.turn_completed"] ?? {}
    const optional = Object.entries(turn).filter(([, spec]) => !spec.required).map(([key]) => key).sort()
    expect(optional).toEqual(["gen_ai.request.model", "gen_ai.response.model", "omo.machine_hash"])
    for (const [event, attributes] of Object.entries(SENPI.events)) {
      expect(attributes["log.record.uid"]?.required).toBe(true)
      if (attributes["session.id"] !== undefined) {
        expect(`${event} ${attributes["session.id"].required}`).toBe(`${event} ${event !== "omo.process_crashed"}`)
      }
    }
  })

  test("#given a process_crashed record without session.id #when checked against the artifact #then it validates", () => {
    const crashed = SENPI.events["omo.process_crashed"] ?? {}
    const record: Record<string, unknown> = {
      "log.record.uid": "0190f1a2-0000-7000-8000-000000000000",
      "omo.detection": "supervisor",
      "process.exit.code": 139,
      "omo.signal": "SIGSEGV",
      "omo.crashed_omo_version": "5.1.33",
      "omo.crashed_bun_version": "unknown",
    }
    const missing = Object.entries(crashed).filter(([key, spec]) => spec.required && record[key] === undefined)
    expect(missing).toEqual([])
    for (const [key, value] of Object.entries(record)) {
      const spec = crashed[key]
      expect(spec).toBeDefined()
      if (spec?.values !== undefined) expect(spec.values).toContain(String(value))
      if (spec?.pattern !== undefined) expect(matches(spec.pattern, String(value))).toBe(true)
    }
  })

  test("#then the scope list, the SDK-name enum and the version pattern are in every artifact, and a path or an email is not an SDK name", () => {
    for (const artifact of ARTIFACTS) {
      expect(artifact.scope.name.length).toBeGreaterThan(0)
      expect(matches(artifact.scope.version, "5.1.33")).toBe(true)
      const sdk = artifact.resource["telemetry.sdk.name"]
      expect(sdk?.values).toEqual(["opentelemetry", "omo-otel-minimal"])
      expect(sdk?.values).not.toContain("/srv/customer/alice/report.txt")
      expect(sdk?.values).not.toContain("alice@example.test")
      expect(matches(artifact.resource["service.version"]?.pattern ?? "", "5.1.33-beta.2")).toBe(true)
    }
  })

  test("#then the D-I fixtures match their patterns and the hostile values do not", () => {
    for (const value of ["custom/custom/none", "anthropic/claude-opus-5-5/medium+1", "disabled"]) {
      expect(`${value} ${matches(CATEGORY_VALUE_PATTERN, value)}`).toBe(`${value} true`)
    }
    for (const value of ["/srv/customer/alice/report.txt", "custom/custom/none+0", "a b c"]) {
      expect(`${value} ${matches(CATEGORY_VALUE_PATTERN, value)}`).toBe(`${value} false`)
      expect(matches(PROVIDERS_PATTERN, value)).toBe(false)
    }
    // A path and prose fail the timezone syntax bound; a relative token is accepted by design (D-I).
    for (const value of ["/srv/customer/alice/report.txt", "a b c"]) expect(matches(TIMEZONE_PATTERN, value)).toBe(false)
    for (const value of ["25.3.0", "6.8.0-45-generic", "10.0.22631"]) expect(matches(OS_VERSION_PATTERN, value)).toBe(true)
    expect(matches(PROVIDERS_PATTERN, "anthropic,openai,custom")).toBe(true)
    expect(matches(PROVIDERS_PATTERN, "")).toBe(false)
    for (const zone of ["Etc/GMT+9", "CST6CDT", "America/Argentina/Buenos_Aires", "Asia/Seoul", "UTC"]) {
      expect(matches(TIMEZONE_PATTERN, zone)).toBe(true)
    }
    expect(matches(CRASH_VERSION_PATTERN, "unknown")).toBe(true)
    expect(matches(CRASH_VERSION_PATTERN, "/usr/local/bin")).toBe(false)
  })

  test("#then every zone name in this machine's tzdata (excluding posix/ and right/) matches the timezone pattern", () => {
    const root = "/usr/share/zoneinfo"
    const zones: string[] = []
    const walk = (relative: string): void => {
      for (const entry of readdirSync(join(root, relative))) {
        const path = relative === "" ? entry : `${relative}/${entry}`
        if (relative === "" && (entry === "posix" || entry === "right")) continue
        const stats = statSync(join(root, path))
        if (stats.isDirectory()) walk(path)
        else if (readFileSync(join(root, path)).subarray(0, 4).toString("latin1") === "TZif") zones.push(path)
      }
    }
    walk("")
    expect(zones.length).toBeGreaterThan(300)
    expect(zones.filter((zone) => !matches(TIMEZONE_PATTERN, zone))).toEqual([])
  })

  test("#then the provider and architecture VALUE tables cover every id and round-trip wire -> id -> wire", () => {
    const providerRows = SENPI.values["gen_ai.provider.name"]?.rows ?? []
    for (const provider of [...KNOWN_PROVIDERS, "custom"]) expect(providerRows.map(({ id }) => id)).toContain(provider)
    expect(providerRows.find(({ id }) => id === "google")?.wire).toBe("gcp.gemini")
    expect(providerRows.find(({ id }) => id === "xai")?.wire).toBe("x_ai")
    const archRows = SENPI.values["host.arch"]?.rows ?? []
    for (const nodeArch of ["x64", "arm64", "ia32", "arm"]) expect(archRows.map(({ id }) => id)).toContain(nodeArch)
    for (const table of Object.values(SENPI.values)) {
      const inverse = new Map(table.rows.map(({ id, wire }) => [wire, id]))
      expect(inverse.size).toBe(table.rows.length)
      for (const [wire, id] of inverse) expect(table.rows.find((row) => row.id === id)?.wire).toBe(wire)
    }
  })

  test("#given a string property without values or pattern #when generating #then the generator refuses", () => {
    expect(() => buildTelemetryArtifacts({ ...OMO_NATIVE_EVENT_SCHEMAS, scratch_event: { $session_id: { type: "string" }, free_text_note: { type: "string" } } }))
      .toThrow("scratch_event.free_text_note: string property without values or pattern")
  })

  test("#given a property that has a semantic convention but no map entry #when generating #then the generator refuses", () => {
    expect(() => buildTelemetryArtifacts({ ...OMO_NATIVE_EVENT_SCHEMAS, scratch_event: { $session_id: { type: "string" }, error_type: { type: "string", values: ["x"] } } }))
      .toThrow("scratch_event.error_type has a semantic convention but no entry in semconv-map.json")
  })
})
