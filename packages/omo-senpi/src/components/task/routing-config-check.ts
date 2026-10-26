// The omo config fields that decide which model a child runs on: category and agent entries (model, models and
// fallback chains, reasoning selectors), the excluded models, and the model catalog. A spawn re-checks them on every
// layer it reads (#11355), because the loader keeps a layer with a bad leaf by dropping that leaf, and a dropped
// routing leaf silently routes the child on another layer or the defaults.

const ROUTING_PATH = /^(?:\[[^\]]+\]\.)?(?:categories|agents|exclude_models|models)(?:\.|$)/
// "provider/model", or a model catalog name that resolves to one.
const MODEL_REF = /^[^\s/]+\/\S+$/
const SELECTOR_FIELDS = ["variant", "reasoningEffort", "provider"] as const
const CHAIN_FIELDS = ["models", "fallback_models"] as const

export function isRoutingPath(issuePath: string): boolean {
  return ROUTING_PATH.test(issuePath)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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

/** The routing-field paths one layer gets wrong, as written: wrong types, null, and model ids that are not "provider/model" or a catalog name. */
export function routingIssues(layer: unknown, catalogNames: ReadonlySet<string>): readonly string[] {
  if (!isRecord(layer)) return []
  const issues: string[] = []
  const isModelRef = (value: unknown): boolean => typeof value === "string" && (MODEL_REF.test(value) || catalogNames.has(value))
  checkEntries(layer["categories"], "categories", issues, isModelRef)
  checkEntries(layer["agents"], "agents", issues, isModelRef)
  const excluded = layer["exclude_models"]
  if (excluded !== undefined && (!Array.isArray(excluded) || excluded.some((item: unknown) => typeof item !== "string"))) issues.push("exclude_models")
  return issues
}

/** Model catalog names any layer defines: a routing field may name one instead of "provider/model". */
export function catalogNames(layers: readonly unknown[]): ReadonlySet<string> {
  const names = new Set<string>()
  for (const layer of layers) {
    const catalog = isRecord(layer) ? layer["models"] : undefined
    if (isRecord(catalog)) for (const name of Object.keys(catalog)) names.add(name)
  }
  return names
}
