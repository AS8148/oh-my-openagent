import { normalizeLegacyModelFields } from "@oh-my-opencode/omo-config-core"

// The omo config fields that decide which model a Senpi child runs on: category and agent entries (model, models and
// fallback chains, reasoning selectors), the excluded models, and the model catalog. A spawn re-checks them on every
// layer it reads (#11355), because the loader keeps a layer with a bad leaf by dropping that leaf, and a dropped
// routing leaf silently routes the child on another layer or the defaults.
//
// Only the scopes the Senpi view merges route a Senpi child, in the loader's order (resolution.ts): the base layer,
// its Senpi harness blocks (legacy `[senpi]`, then canonical `[native]`), the ACTIVE profile, and that profile's
// Senpi harness blocks. Another harness's block (`[codex]`, `[opencode]`) or an inactive profile never routes one.
const SENPI_HARNESS_BLOCKS = ["[senpi]", "[native]"] as const
const ROUTING_FIELDS = String.raw`(?:categories|agents|exclude_models|models)(?:\.|$)`
const HARNESS_PREFIX = String.raw`(?:\[(?:senpi|native)\]\.)?`
// "provider/model", or a model catalog name that resolves to one.
const MODEL_REF = /^[^\s/]+\/\S+$/
const SELECTOR_FIELDS = ["variant", "reasoningEffort", "provider"] as const
const CHAIN_FIELDS = ["models", "fallback_models"] as const

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Whether a loader issue path is a field that routes a Senpi child under the active profile. */
export function isRoutingPath(issuePath: string, profile?: string): boolean {
  const profilePrefix = profile === undefined ? "" : String.raw`(?:profiles\.${escapeRegExp(profile)}\.)?`
  return new RegExp(`^${profilePrefix}${HARNESS_PREFIX}${ROUTING_FIELDS}`).test(issuePath)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The scopes of one layer that the Senpi view merges, each with the path prefix a field in it is reported under. */
function senpiScopes(layer: unknown, profile: string | undefined): readonly (readonly [prefix: string, scope: Record<string, unknown>])[] {
  if (!isRecord(layer)) return []
  const scopes: (readonly [string, Record<string, unknown>])[] = [["", layer]]
  const withBlocks = (prefix: string, scope: Record<string, unknown>) => {
    for (const block of SENPI_HARNESS_BLOCKS) {
      const value = scope[block]
      if (isRecord(value)) scopes.push([`${prefix}${block}.`, value])
    }
  }
  withBlocks("", layer)
  const profiles = layer["profiles"]
  const active = profile !== undefined && isRecord(profiles) ? profiles[profile] : undefined
  if (isRecord(active)) {
    const prefix = `profiles.${profile}.`
    scopes.push([prefix, active])
    withBlocks(prefix, active)
  }
  return scopes
}

// The loader reads the legacy reasoning suffixes ("model (high)", "model high") as "model:high"; check the same form.
function canonicalModel(value: string): string {
  const normalized = normalizeLegacyModelFields({ model: value })["model"]
  return typeof normalized === "string" ? normalized : value
}

function checkSelectors(entry: Record<string, unknown>, at: string, issues: string[]): void {
  for (const key of SELECTOR_FIELDS) if (key in entry && typeof entry[key] !== "string") issues.push(`${at}.${key}`)
}

function checkChain(value: unknown, at: string, issues: string[], isModelRef: (value: unknown) => boolean, allowsSingle: boolean): void {
  if (allowsSingle && typeof value === "string") {
    if (!isModelRef(value)) issues.push(at)
    return
  }
  if (!Array.isArray(value)) {
    issues.push(at)
    return
  }
  value.forEach((item: unknown, index) => {
    const itemAt = `${at}.${index}`
    if (typeof item === "string") {
      if (!isModelRef(item)) issues.push(itemAt)
      return
    }
    if (!isRecord(item) || !isModelRef(item["model"])) {
      issues.push(itemAt)
      return
    }
    checkSelectors(item, itemAt, issues)
  })
}

function checkEntry(entry: unknown, at: string, issues: string[], isModelRef: (value: unknown) => boolean): void {
  if (!isRecord(entry)) {
    issues.push(at)
    return
  }
  if ("model" in entry && !isModelRef(entry["model"])) issues.push(`${at}.model`)
  for (const key of CHAIN_FIELDS) if (key in entry) checkChain(entry[key], `${at}.${key}`, issues, isModelRef, key === "fallback_models")
  checkSelectors(entry, at, issues)
}

function checkEntries(value: unknown, root: string, issues: string[], isModelRef: (value: unknown) => boolean): void {
  if (value === undefined) return
  if (!isRecord(value)) {
    issues.push(root)
    return
  }
  for (const [name, entry] of Object.entries(value)) checkEntry(entry, `${root}.${name}`, issues, isModelRef)
}

/**
 * The routing-field paths one layer gets wrong, as written, in every scope the Senpi view merges: wrong types, null,
 * and model ids that are neither "provider/model" (legacy reasoning suffixes included) nor a catalog name.
 */
export function routingIssues(layer: unknown, catalogNames: ReadonlySet<string>, profile?: string): readonly string[] {
  const issues: string[] = []
  const isModelRef = (value: unknown): boolean => {
    if (typeof value !== "string") return false
    if (catalogNames.has(value)) return true
    const canonical = canonicalModel(value)
    return MODEL_REF.test(canonical) || catalogNames.has(canonical.split(":")[0] ?? canonical)
  }
  for (const [prefix, scope] of senpiScopes(layer, profile)) {
    checkEntries(scope["categories"], `${prefix}categories`, issues, isModelRef)
    checkEntries(scope["agents"], `${prefix}agents`, issues, isModelRef)
    const excluded = scope["exclude_models"]
    if (excluded !== undefined && (!Array.isArray(excluded) || excluded.some((item: unknown) => typeof item !== "string"))) {
      issues.push(`${prefix}exclude_models`)
    }
  }
  return issues
}

/** Model catalog names the Senpi view can resolve: the resolved catalog plus every Senpi scope's `models` in any layer. */
export function catalogNames(layers: readonly unknown[], resolvedCatalog: unknown, profile?: string): ReadonlySet<string> {
  const names = new Set<string>(isRecord(resolvedCatalog) ? Object.keys(resolvedCatalog) : [])
  for (const layer of layers) {
    for (const [, scope] of senpiScopes(layer, profile)) {
      const catalog = scope["models"]
      if (isRecord(catalog)) for (const name of Object.keys(catalog)) names.add(name)
    }
  }
  return names
}
