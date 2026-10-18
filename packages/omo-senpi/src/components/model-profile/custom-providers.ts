import { join } from "node:path"

import { readJsoncFile } from "@oh-my-opencode/utils"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Providers the user declared in `<agentDir>/models.json` with models of their own, in declaration
 * order. A builtin profile rung may resolve to one of these after its listed providers (#10485):
 * the user configured them on purpose, unlike a gateway the registry merely exposes. An entry that
 * only overrides a built-in provider (`baseUrl`, credentials) carries no `models` and is not listed.
 */
export function customModelProviders(agentDir: string | undefined): readonly string[] {
  if (agentDir === undefined) return []
  const parsed = readJsoncFile<unknown>(join(agentDir, "models.json"))
  const providers = isRecord(parsed) ? parsed["providers"] : undefined
  if (!isRecord(providers)) return []
  return Object.entries(providers)
    .filter(([, entry]) => isRecord(entry) && Array.isArray(entry["models"]) && entry["models"].length > 0)
    .map(([id]) => id)
}
