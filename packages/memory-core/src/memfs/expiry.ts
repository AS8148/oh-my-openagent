/**
 * The `expires` frontmatter key: the instant after which a memory file is no longer projected (#11450).
 *
 * Accepted values are ISO 8601 with an unambiguous instant:
 * - a date (`2026-10-28`): the start of that UTC day;
 * - a datetime with `Z` or a numeric offset (`2026-10-27T06:33Z`, `2026-10-27T15:33:00+09:00`).
 *
 * Anything else (an offset-less datetime, which means a different instant on each device; free text; an impossible
 * calendar date) reads as "no expiry", so a malformed value never hides content.
 */

import { decodeScalarSource } from "./frontmatter-scalar"
import type { MemoryFrontmatter } from "./frontmatter"

export const MEMORY_EXPIRES_KEY = "expires"

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/

/** The instant (epoch ms) the file stops being projected, or `undefined` when it declares no readable expiry. */
export function memoryExpiresAtMs(frontmatter: MemoryFrontmatter): number | undefined {
  const raw = frontmatter.extra?.[MEMORY_EXPIRES_KEY]
  return raw === undefined ? undefined : parseExpiryInstant(decodeScalarSource(raw.trim()))
}

/** A file is expired from its instant on: at `expiresAtMs` itself it is no longer projected. */
export function isMemoryExpired(expiresAtMs: number | undefined, asOfMs: number): boolean {
  return expiresAtMs !== undefined && asOfMs >= expiresAtMs
}

export function parseExpiryInstant(value: string): number | undefined {
  const date = DATE_RE.exec(value)
  if (date !== null) return utcInstant(Number(date[1]), Number(date[2]), Number(date[3]), 0, 0, 0, 0, 0)
  const instant = INSTANT_RE.exec(value)
  if (instant === null) return undefined
  const [, year, month, day, hour, minute, second, fraction, zone] = instant
  const offsetMinutes = zone === undefined || zone === "Z" ? 0 : zoneOffsetMinutes(zone)
  if (offsetMinutes === undefined) return undefined
  const ms = fraction === undefined ? 0 : Math.floor(Number(`0.${fraction}`) * 1000)
  return utcInstant(Number(year), Number(month), Number(day), Number(hour), Number(minute), Number(second ?? "0"), ms, offsetMinutes)
}

function zoneOffsetMinutes(zone: string): number | undefined {
  const hours = Number(zone.slice(1, 3))
  const minutes = Number(zone.slice(4, 6))
  if (hours > 23 || minutes > 59) return undefined
  return (zone.startsWith("-") ? -1 : 1) * (hours * 60 + minutes)
}

function utcInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  offsetMinutes: number,
): number | undefined {
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return undefined
  const local = Date.UTC(year, month - 1, day, hour, minute, second, ms)
  const check = new Date(local)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return undefined
  return local - offsetMinutes * 60_000
}
