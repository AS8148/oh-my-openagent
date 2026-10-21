/**
 * `exclude_models` matching. An entry with a `/` is matched against the whole `provider/model`; one
 * without is matched against the model id served by any provider. `*` matches any run of characters
 * (including none, and including `/`), and matching ignores case, so `claude-fable-*` keeps every
 * Fable build out whichever provider serves it. Blank entries match nothing.
 */

function patternExpression(pattern: string): RegExp {
  const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")
  return new RegExp(`^${escaped}$`, "i")
}

export function excludedModelPattern(model: string, patterns: readonly string[] | undefined): string | undefined {
  if (patterns === undefined || patterns.length === 0) return undefined
  const separator = model.indexOf("/")
  const modelId = separator === -1 ? model : model.slice(separator + 1)
  for (const raw of patterns) {
    const pattern = raw.trim()
    if (pattern.length === 0) continue
    const subject = pattern.includes("/") ? model : modelId
    if (patternExpression(pattern).test(subject)) return raw
  }
  return undefined
}

export function isExcludedModel(model: string, patterns: readonly string[] | undefined): boolean {
  return excludedModelPattern(model, patterns) !== undefined
}
