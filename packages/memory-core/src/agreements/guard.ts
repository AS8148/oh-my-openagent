import { parseMemoryFile } from "../memfs"
import { parseAgreementsLedger } from "./format"
import type { AgreementItem } from "./types"

export function readAgreementsBody(content: string | undefined): readonly AgreementItem[] {
  if (content === undefined) return []
  return parseAgreementsLedger(parseMemoryFile(content).body).items
}

/**
 * Automation (the memory tools, reflection, dream) may count and reword agent items but must never
 * create, change, or remove an item the person wrote. Returns the reason a write breaks that rule.
 */
export function describeAgreementsToolViolation(
  before: string | undefined,
  after: string | undefined,
): string | undefined {
  const humanBefore = readAgreementsBody(before).filter((item) => item.by === "human")
  if (after === undefined) {
    return humanBefore.length === 0 ? undefined : "system/agreements.md holds agreements your person wrote; only they can remove them (/agreements drop)"
  }
  let parsed
  try {
    parsed = parseAgreementsLedger(parseMemoryFile(after).body)
  } catch (error) {
    return `system/agreements.md is not a valid memory file: ${error instanceof Error ? error.message : String(error)}`
  }
  if (parsed.diagnostics.length > 0) return `system/agreements.md is malformed: ${parsed.diagnostics.join("; ")}`
  const humanAfter = new Map(parsed.items.filter((item) => item.by === "human").map((item) => [item.id, item]))
  for (const item of humanBefore) {
    const kept = humanAfter.get(item.id)
    if (kept === undefined) return `agreement ${item.id} was written by your person and cannot be removed by automation`
    if (kept.text !== item.text || kept.scope !== item.scope) {
      return `agreement ${item.id} was written by your person and cannot be reworded by automation`
    }
    humanAfter.delete(item.id)
  }
  const forged = [...humanAfter.keys()][0]
  return forged === undefined ? undefined : `agreement ${forged} is marked by: human, which only /agreements add may write`
}
