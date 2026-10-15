import { DELEGATION_REASONING_EFFORTS } from "./delegation-schema"
import type { OmoNativeEventName, OmoNativePropertySchema } from "./event-schemas"
import { ALL_KNOWN_MODEL_IDS, KNOWN_PROVIDERS } from "./model-vocabulary"

/**
 * The constraints sidecar of the telemetry schema artifact (plan D-I): every string property gets a
 * closed value list or an anchored pattern, every number gets bounds, and every event declares which
 * attributes are required. `event-schemas.ts` stays the PostHog allowlist; this file adds what the
 * collector enforces on the wire. The artifact generator fails on any string or number this file does
 * not cover, so a new property cannot ship without a constraint.
 */

export type PropertyConstraint = {
  readonly values?: readonly string[]
  readonly pattern?: string
  readonly integer?: boolean
  readonly min?: number
  readonly max?: number
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
}

function alternation(values: Iterable<string>): string {
  return [...values].map(escapeRegExp).join("|")
}

export const VERSION_PATTERN = "^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$"
export const OS_VERSION_PATTERN = "^[0-9]+(\\.[0-9]+){1,3}(-[0-9A-Za-z.-]{1,32})?$"
export const SESSION_ID_PATTERN = "^[0-9a-f]{64}$"
export const INSTALL_HASH_PATTERN = "^[0-9a-f]{64}$"
export const INSTANCE_ID_PATTERN = "^[0-9a-f]{32}$"
export const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
export const DAY_UTC_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
export const TIMEZONE_PATTERN = "^[A-Za-z0-9_+-]{1,32}(/[A-Za-z0-9_+-]{1,32}){0,2}$"
export const WAVE_HISTOGRAM_PATTERN = "^[0-9:,]{1,64}$"
export const COMBO_FINGERPRINT_PATTERN = "^[0-9a-f]{16}$"
/** A crash-time runtime version exactly as omo-native-crash.ts `versionOrUnknown` emits it. */
export const CRASH_VERSION_PATTERN = "^(?:unknown|[0-9][0-9A-Za-z.+-]{0,31})$"

const PROVIDER_ALTERNATION = alternation([...KNOWN_PROVIDERS, "custom"])
const MODEL_ALTERNATION = alternation([...ALL_KNOWN_MODEL_IDS, "custom"])
const REASONING_ALTERNATION = alternation(DELEGATION_REASONING_EFFORTS)

/** `providers`: comma-joined known provider ids or `custom` (omo-native-session's inventory emitter). */
export const PROVIDERS_PATTERN = `^(?:${PROVIDER_ALTERNATION})(?:,(?:${PROVIDER_ALTERNATION}))*$`

/**
 * `cat_*`: exactly what encodeCategory emits: `<provider>/<model>/<reasoning>` with an optional
 * `+<depth>` (omitted at depth 0), or one of the three state tokens. Never a character class.
 */
export const CATEGORY_VALUE_PATTERN = `^(?:disabled|unavailable|absent|(?:${PROVIDER_ALTERNATION})/(?:${MODEL_ALTERNATION})/(?:${REASONING_ALTERNATION})(?:\\+[1-9][0-9]?)?)$`

/** Events with no session by design; every other event requires `session.id`. */
export const SESSIONLESS_EVENTS: ReadonlySet<string> = new Set(["process_crashed", "forget_request", "client_dropped"])

/** Events whose every attribute is required: a turn row is meaningless without any of its fields. */
const FULLY_REQUIRED_EVENTS: ReadonlySet<string> = new Set(["turn_completed"])

const TOKENS = { min: 0, max: 1e12 } as const
const COST_USD = { min: 0, max: 1e6 } as const
const COST_1E4 = { integer: true, min: 0, max: 1e10 } as const
const TURN_INDEX = { integer: true, min: 0, max: 1e7 } as const
const DURATION = { min: 0, max: 1e10 } as const
const COUNT = { min: 0, max: 1e9 } as const
const RATE = { min: 0, max: 1 } as const
// Process exit codes: POSIX 0..255 and signed Windows NTSTATUS values both fit.
const EXIT_CODE = { integer: true, min: -2_147_483_648, max: 4_294_967_295 } as const

const STRING_CONSTRAINTS: Readonly<Record<string, PropertyConstraint>> = {
  $session_id: { pattern: SESSION_ID_PATTERN },
  day_utc: { pattern: DAY_UTC_PATTERN },
  providers: { pattern: PROVIDERS_PATTERN },
  timezone: { pattern: TIMEZONE_PATTERN },
  non_eval_wave_size_histogram: { pattern: WAVE_HISTOGRAM_PATTERN },
  combo_fingerprint: { pattern: COMBO_FINGERPRINT_PATTERN },
  crashed_bun_version: { pattern: CRASH_VERSION_PATTERN },
  crashed_engine_version: { pattern: CRASH_VERSION_PATTERN },
  crashed_omo_version: { pattern: CRASH_VERSION_PATTERN },
}

/** Bounds for one numeric property, decided by what it measures; unknown names are counts. */
export function numberConstraint(property: string): PropertyConstraint {
  if (property === "cost_1e4") return COST_1E4
  if (property === "sample_rate") return RATE
  if (property === "exit_code") return EXIT_CODE
  if (property === "turn_index" || property === "first_turn_index" || property === "last_turn_index") return TURN_INDEX
  if (/(?:^|_)cost_usd$/.test(property)) return COST_USD
  if (/_tokens(?:_|$)/.test(property)) return TOKENS
  if (/(?:^|_)ms(?:_|$)/.test(property)) return DURATION
  return COUNT
}

/**
 * The constraint for one property of one event: the schema's own closed values when it has them,
 * else the pattern table, else the composed `cat_*` pattern; numbers get bounds. Undefined means the
 * property has no constraint, which the artifact generator turns into a hard failure.
 */
export function propertyConstraint(
  property: string,
  schema: OmoNativePropertySchema,
): PropertyConstraint | undefined {
  if (schema.type === "boolean") return {}
  if (schema.type === "number") return numberConstraint(property)
  if (schema.values !== undefined) return { values: schema.values }
  if (property.startsWith("cat_")) return { pattern: CATEGORY_VALUE_PATTERN }
  return STRING_CONSTRAINTS[property]
}

export function isPropertyRequired(event: OmoNativeEventName | string, property: string): boolean {
  if (FULLY_REQUIRED_EVENTS.has(event)) return true
  return property === "$session_id" && !SESSIONLESS_EVENTS.has(event)
}
