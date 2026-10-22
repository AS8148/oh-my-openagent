import { readFileSync } from "node:fs"
import { join } from "node:path"

import { KNOWN_PROVIDERS } from "./product-identity"
import type { OmoNativeInventoryDiagnostic } from "./session-inventory"

/**
 * Accounts per provider kind (#10919), counts only: `connected` from the accounts the engine holds in `auth.json`,
 * `active` from its credential pool (`credential-pool-state.json`): distinct slots with a live lease now or a success
 * in the last 5 hours (the subscription rate-limit window). Both are `kind:count` lists over the shipped provider
 * kinds, unknown kinds summed into `custom`, each count capped at `10_plus`. No account name, email, token, slot key
 * or lease id is kept: only array lengths and slot counts.
 */
export type AccountInventory = { readonly connected: string; readonly active: string }

const ACTIVE_WINDOW_MS = 5 * 3_600_000
const CAP = 10
const RETIRED: Readonly<Record<string, string>> = Object.freeze({
  "claude-sdk-oauth": "anthropic-subscription",
  "openai-codex": "chatgpt-subscription",
})

export function readAccountInventory(
  agentDir: string,
  now: number,
  diagnostics?: (input: OmoNativeInventoryDiagnostic) => void,
): AccountInventory {
  const connected = new Map<string, number>()
  const auth = readOptional(join(agentDir, "auth.json"), "auth.json", diagnostics)
  for (const [id, node] of Object.entries(auth)) {
    const accounts = isRecord(node) ? Reflect.get(node, "accounts") : undefined
    add(
      connected,
      kindOf(id),
      Array.isArray(accounts) && accounts.length > 0 ? accounts.length : 1,
    )
  }
  const active = new Map<string, number>()
  const pool = readOptional(
    join(agentDir, "credential-pool-state.json"),
    "credential-pool-state.json",
    diagnostics,
  )
  const providers = Reflect.get(pool, "providers")
  for (const [id, provider] of Object.entries(isRecord(providers) ? providers : {})) {
    const lanes = isRecord(provider) ? Reflect.get(provider, "lanes") : undefined
    const live = new Set<string>()
    for (const lane of Object.values(isRecord(lanes) ? lanes : {})) {
      const slots = isRecord(lane) ? Reflect.get(lane, "slots") : undefined
      for (const [key, slot] of Object.entries(isRecord(slots) ? slots : {}))
        if (isActive(slot, now)) live.add(key)
    }
    if (live.size > 0) add(active, kindOf(id), live.size)
  }
  return { connected: render(connected), active: render(active) }
}

function isActive(slot: unknown, now: number): boolean {
  if (!isRecord(slot)) return false
  const lease = Reflect.get(slot, "lease")
  const expiresAt = isRecord(lease) ? Reflect.get(lease, "expiresAt") : undefined
  if (typeof expiresAt === "number" && expiresAt > now) return true
  const lastSuccessAt = Reflect.get(slot, "lastSuccessAt")
  return typeof lastSuccessAt === "number" && now - lastSuccessAt <= ACTIVE_WINDOW_MS
}

function kindOf(id: string): string {
  const current = RETIRED[id] ?? id
  return KNOWN_PROVIDERS.some((known) => known === current) ? current : "custom"
}

function add(counts: Map<string, number>, kind: string, n: number): void {
  counts.set(kind, (counts.get(kind) ?? 0) + n)
}

function render(counts: ReadonlyMap<string, number>): string {
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([kind, n]) => `${kind}:${n >= CAP ? "10_plus" : String(n)}`)
    .join(",")
}

/** A missing file is empty; an unreadable one reports ONE fixed diagnostic (a parse message can quote a credential). */
function readOptional(
  path: string,
  name: string,
  diagnostics: ((input: OmoNativeInventoryDiagnostic) => void) | undefined,
): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (!isRecord(parsed)) throw new Error("not an object")
    return parsed
  } catch (error) {
    if (Reflect.get(Object(error), "code") !== "ENOENT") {
      diagnostics?.({
        event: "omo_native_inventory_read_failed",
        error: new Error(`${name} is unreadable or not a JSON object`),
        source: "omo-native-session",
      })
    }
    return {}
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
