// Deterministic item rendering (sync-design §2, §5): frontmatter keys in first-write
// (Lamport, peer) order, values combined per the kind rule, then the body exactly as
// stored. A dead item (isLive false) is absent from disk and renders null.

import type { LoroDoc } from "loro-crdt"

import { isLive } from "./document"
import { renderScalar } from "./frontmatter"
import type { Stamp } from "./history"
import { analyzeHistory } from "./history"
import { BODY_NAME, cidRoot, combineKey, readKeyState } from "./state"

export function renderItem(doc: LoroDoc): string | null {
  if (!isLive(doc)) return null
  return renderDocContent(doc)
}

/** Content render regardless of liveness; capture's baseline check uses this. */
export function renderDocContent(doc: LoroDoc): string {
  const history = analyzeHistory(doc)
  const lines: string[] = []
  const keys = [...history.keys.entries()].sort((a, b) => stampCompare(a[1].first, b[1].first))
  for (const [key, kh] of keys) {
    const combined = combineKey(readKeyState(doc, key), key, kh, history)
    if (combined === null) continue
    if (combined.kind === "set") {
      lines.push(`${renderScalar(key)}:`)
      for (const element of combined.elements) lines.push(`  - ${element}`)
    } else {
      lines.push(`${renderScalar(key)}: ${combined.text}`)
    }
  }
  const body = doc.hasContainer(cidRoot(BODY_NAME, "Text")) ? doc.getText(BODY_NAME).toString() : ""
  if (lines.length === 0) return body
  return `---\n${lines.join("\n")}\n---\n${body}`
}

function stampCompare(a: Stamp, b: Stamp): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport
  const pa = BigInt(a.peer)
  const pb = BigInt(b.peer)
  return pa < pb ? -1 : pa > pb ? 1 : 0
}
