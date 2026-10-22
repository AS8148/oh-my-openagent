import { readFileSync } from "node:fs"
import { join } from "node:path"

import * as piAi from "@earendil-works/pi-ai"

import { KNOWN_PROVIDERS } from "./product-identity"
import { RETIRED_PROVIDER_IDS } from "./session-inventory"

/**
 * Linked accounts per provider kind (#10919): for each provider, the number of accounts the engine itself lists
 * (senpi `getCredentialAccounts`, the listing the app's account list shows), counts only. senpi does not export that
 * function, so its rules are mirrored here and `account-inventory.test.ts` asserts parity against the real engine
 * function from the installed dist on every fixture, so an engine rule change fails the test:
 * - Claude (`anthropic-subscription`): the stored `accounts` list (no list, the managed sign-in sentinel, is zero; an
 *   empty list is the flat credential, one), plus every env slot (`CLAUDE_CODE_OAUTH_TOKEN`, `_2` .. `_16`);
 * - any other provider: the stored `accounts` list when it is non-empty, else the flat credential as one account;
 *   env slots only when nothing is stored.
 * Rendered as a `kind:count` list over the shipped provider kinds, unknown kinds summed into `custom`, each count
 * capped at `10_plus`. No account name, email, token, id or env value is kept: only lengths and presence.
 * pi-ai is read through a namespace import so a host whose pi-ai lacks one of these exports degrades to no count
 * instead of failing to link the whole extension.
 */
const CLAUDE = "anthropic-subscription"
const MAX_ENV_SLOT_INDEX = 16
const CAP = 10

type Env = Readonly<Record<string, string | undefined>>

export function readConnectedAccounts(agentDir: string, env: Env): string {
  if (!engineTablesAvailable()) return ""
  const kinds = new Map<string, number>()
  for (const [provider, count] of connectedAccountCounts(readAuth(join(agentDir, "auth.json")), env)) {
    const kind = kindOf(provider)
    kinds.set(kind, (kinds.get(kind) ?? 0) + count)
  }
  return [...kinds.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([kind, n]) => `${kind}:${n >= CAP ? "10_plus" : String(n)}`)
    .join(",")
}

export function connectedAccountCounts(auth: Readonly<Record<string, unknown>>, env: Env): Map<string, number> {
  const stored = new Map<string, unknown>()
  for (const [key, value] of Object.entries(auth)) {
    const canonical = piAi.normalizeProviderId(key)
    if (!stored.has(canonical) || key === canonical) stored.set(canonical, value)
  }
  const counts = new Map<string, number>()
  for (const provider of new Set([...stored.keys(), ...piAi.apiKeyEnvProviders(), CLAUDE])) {
    const count = engineAccountCount(provider, stored.get(provider), env)
    if (count > 0) counts.set(provider, count)
  }
  return counts
}

function engineTablesAvailable(): boolean {
  return typeof piAi.normalizeProviderId === "function" && typeof piAi.getApiKeyEnvVars === "function" && typeof piAi.apiKeyEnvProviders === "function"
}

function engineAccountCount(provider: string, credential: unknown, env: Env): number {
  const claude = piAi.normalizeProviderId(provider) === CLAUDE
  if (credential !== undefined && credential !== null && credential !== false && credential !== "" && credential !== 0) {
    const accounts = typeof credential === "object" ? Reflect.get(credential, "accounts") : undefined
    const listed = Array.isArray(accounts) && accounts.length > 0 ? accounts.length : 1
    if (!claude) return listed
    return (Array.isArray(accounts) ? listed : 0) + envSlotCount(provider, env)
  }
  return envSlotCount(provider, env)
}

function envSlotCount(provider: string, env: Env): number {
  const primary = primaryEnvVar(provider)
  if (primary === undefined) return 0
  let count = env[primary] ? 1 : 0
  for (let index = 2; index <= MAX_ENV_SLOT_INDEX; index++) if (env[`${primary}_${index}`]) count++
  return count
}

function primaryEnvVar(provider: string): string | undefined {
  if (piAi.normalizeProviderId(provider) === CLAUDE) return "CLAUDE_CODE_OAUTH_TOKEN"
  const names = piAi.getApiKeyEnvVars(provider)
  if (!names || names.length === 0) return undefined
  return names.find((name) => name.endsWith("_API_KEY")) ?? names[0]
}

function kindOf(provider: string): string {
  const current = RETIRED_PROVIDER_IDS[provider] ?? provider
  return KNOWN_PROVIDERS.some((known) => known === current) ? current : "custom"
}

/** An unreadable auth.json counts nothing here; readOmoNativeInventory reports it once with a fixed message. */
function readAuth(path: string): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
