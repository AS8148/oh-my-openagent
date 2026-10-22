import { readFileSync } from "node:fs"
import { join } from "node:path"

import { KNOWN_PROVIDERS } from "./product-identity"
import type { OmoNativeInventoryDiagnostic } from "./session-inventory"

/**
 * Linked accounts per provider kind (#10919), counts only: how many accounts the engine holds for each provider in
 * `auth.json` (the length of its account list, or 1 for a single-credential provider), used or not. A `kind:count`
 * list over the shipped provider kinds, unknown kinds summed into `custom`, each count capped at `10_plus`. No account
 * name, email, token or id is kept: only list lengths.
 */
const CAP = 10
const RETIRED: Readonly<Record<string, string>> = Object.freeze({
  "claude-sdk-oauth": "anthropic-subscription",
  "openai-codex": "chatgpt-subscription",
})

export function readConnectedAccounts(agentDir: string, diagnostics?: (input: OmoNativeInventoryDiagnostic) => void): string {
  const counts = new Map<string, number>()
  for (const [id, node] of Object.entries(readAuth(join(agentDir, "auth.json"), diagnostics))) {
    const accounts = isRecord(node) ? Reflect.get(node, "accounts") : undefined
    const kind = kindOf(id)
    counts.set(kind, (counts.get(kind) ?? 0) + (Array.isArray(accounts) && accounts.length > 0 ? accounts.length : 1))
  }
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([kind, n]) => `${kind}:${n >= CAP ? "10_plus" : String(n)}`)
    .join(",")
}

function kindOf(id: string): string {
  const current = RETIRED[id] ?? id
  return KNOWN_PROVIDERS.some((known) => known === current) ? current : "custom"
}

/** A missing file is empty; an unreadable one reports ONE fixed diagnostic (a parse message can quote a credential). */
function readAuth(path: string, diagnostics: ((input: OmoNativeInventoryDiagnostic) => void) | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (!isRecord(parsed)) throw new Error("not an object")
    return parsed
  } catch (error) {
    if (Reflect.get(Object(error), "code") !== "ENOENT") {
      diagnostics?.({ event: "omo_native_inventory_read_failed", error: new Error("auth.json is unreadable or not a JSON object"), source: "omo-native-session" })
    }
    return {}
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
