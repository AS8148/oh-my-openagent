import { readFileSync } from "node:fs"
import { join } from "node:path"

import { KNOWN_PROVIDERS } from "./product-identity"
import { RETIRED_PROVIDER_IDS } from "./session-inventory"

/**
 * Linked accounts per provider kind (#10919), counts only: for each provider in `auth.json`, the length of its
 * `accounts` list; an entry with no `accounts` list is the single-credential shape and counts as one linked account;
 * an empty list counts as zero, so that provider is not listed. A `kind:count` list over the shipped provider kinds,
 * unknown kinds summed into `custom`, each count capped at `10_plus`. No account name, email, token or id is kept:
 * only list lengths. An unreadable `auth.json` is reported once, by readOmoNativeInventory; here it counts nothing.
 */
const CAP = 10

export function readConnectedAccounts(agentDir: string): string {
  const counts = new Map<string, number>()
  for (const [id, node] of Object.entries(readAuth(join(agentDir, "auth.json")))) {
    const accounts = isRecord(node) ? Reflect.get(node, "accounts") : undefined
    const linked = Array.isArray(accounts) ? accounts.length : 1
    if (linked === 0) continue
    const kind = kindOf(id)
    counts.set(kind, (counts.get(kind) ?? 0) + linked)
  }
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([kind, n]) => `${kind}:${n >= CAP ? "10_plus" : String(n)}`)
    .join(",")
}

function kindOf(id: string): string {
  const current = RETIRED_PROVIDER_IDS[id] ?? id
  return KNOWN_PROVIDERS.some((known) => known === current) ? current : "custom"
}

function readAuth(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
