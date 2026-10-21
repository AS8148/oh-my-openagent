import { agreementId, normalizeAgreementText, sortAgreements } from "./format"
import type { AgreementExtractionRecord, AgreementItem, AgreementScope, AgreementsPolicy } from "./types"

export interface AgreementsMutation {
  readonly items: readonly AgreementItem[]
  readonly newlyFlagged: readonly string[]
  readonly refusedOverCap: readonly string[]
}

export function applyAgreementRecords(
  existing: readonly AgreementItem[],
  records: readonly AgreementExtractionRecord[],
  policy: AgreementsPolicy,
): AgreementsMutation {
  let items = [...existing]
  const flagged = new Set<string>()
  const refused: string[] = []
  const bump = (at: number, date: string, text: string | undefined): void => {
    const found = items[at]
    if (found === undefined) return
    const n = found.n + 1
    const reworded = found.by === "agent" && text !== undefined ? text : found.text
    const status = n >= policy.needsHumanThreshold ? "needs-human" : found.status
    if (status === "needs-human" && found.status !== "needs-human") flagged.add(found.id)
    items[at] = { ...found, text: reworded, n, last: date, status }
  }
  for (const record of records) {
    if (record.action === "reaffirm") {
      bump(items.findIndex((item) => item.id === record.id), record.date, record.text)
      continue
    }
    const at = findAgreement(items, record.text)
    if (at >= 0) {
      bump(at, record.date, undefined)
      continue
    }
    const status = 1 >= policy.needsHumanThreshold ? "needs-human" : "active"
    const created: AgreementItem = {
      id: agreementId(record.text), scope: record.applies, by: "agent", text: record.text,
      n: 1, since: record.date, last: record.date, status,
    }
    if (status === "needs-human") flagged.add(created.id)
    items.push(created)
    if (items.length <= policy.maxItems) continue
    items = mergeOverlappingAgentItems(items)
    if (items.length <= policy.maxItems) continue
    items = items.filter((item) => item.id !== created.id)
    flagged.delete(created.id)
    refused.push(record.text)
  }
  return { items: sortAgreements(items), newlyFlagged: [...flagged], refusedOverCap: refused }
}

export function addHumanAgreement(
  existing: readonly AgreementItem[],
  text: string,
  scope: AgreementScope,
  date: string,
): readonly AgreementItem[] {
  const at = findAgreement(existing, text)
  const found = at >= 0 ? existing[at] : undefined
  const item: AgreementItem = found === undefined
    ? { id: agreementId(text), scope, by: "human", text, n: 0, since: date, status: "active" }
    : { ...found, scope, by: "human", text }
  const rest = existing.filter((_, index) => index !== at)
  return sortAgreements([...rest, item])
}

export function ackAgreement(existing: readonly AgreementItem[], id: string): readonly AgreementItem[] | undefined {
  if (!existing.some((item) => item.id === id)) return undefined
  return existing.map((item) => item.id === id ? { ...item, n: 0, status: "active" } : item)
}

export function dropAgreement(existing: readonly AgreementItem[], id: string): readonly AgreementItem[] | undefined {
  if (!existing.some((item) => item.id === id)) return undefined
  return existing.filter((item) => item.id !== id)
}

export function mergeOverlappingAgentItems(items: readonly AgreementItem[]): AgreementItem[] {
  const ordered = sortAgreements(items)
  const merged: AgreementItem[] = []
  for (const item of ordered) {
    const host = item.by === "agent"
      ? merged.findIndex((kept) => kept.by === "agent" && kept.scope === item.scope && overlaps(kept.text, item.text))
      : -1
    const kept = host >= 0 ? merged[host] : undefined
    if (kept === undefined) {
      merged.push(item)
      continue
    }
    merged[host] = {
      ...kept,
      text: item.text.length > kept.text.length ? item.text : kept.text,
      n: kept.n + item.n,
      ...(laterDate(kept.last, item.last) === undefined ? {} : { last: laterDate(kept.last, item.last) }),
      status: kept.status === "needs-human" || item.status === "needs-human" ? "needs-human" : "active",
    }
  }
  return merged
}

function findAgreement(items: readonly AgreementItem[], text: string): number {
  const id = agreementId(text)
  const normalized = normalizeAgreementText(text)
  return items.findIndex((item) => item.id === id || normalizeAgreementText(item.text) === normalized)
}

function overlaps(a: string, b: string): boolean {
  const left = normalizeAgreementText(a)
  const right = normalizeAgreementText(b)
  if (left.includes(right) || right.includes(left)) return true
  const leftTokens = tokens(left)
  const rightTokens = tokens(right)
  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length
  const union = new Set([...leftTokens, ...rightTokens]).size
  return union > 0 && shared / union >= 0.5
}

function tokens(normalized: string): Set<string> {
  return new Set(normalized.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 2))
}

function laterDate(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return a >= b ? a : b
}
