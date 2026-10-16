// Capture receipts (review r3 #1): every capture that writes ops also records, under the
// device's own peer, a fingerprint of (baseline frontier, working text). The receipt rides
// in the same update as the edit, so it is durable exactly when the edit is: a double-fired
// watcher or a crash between importing the update and saving the new baseline replays the
// same pair, finds the receipt, and writes nothing. One key per device keeps the map
// bounded by device count. Render and history ignore this root (it is not `fm`/`body`).

import { createHash } from "node:crypto"

import type { LoroDoc } from "../../crdt/loro-runtime"

import type { ItemFrontier } from "./document"
import { cidRoot } from "./state"

export const RECEIPTS_NAME = "captures"

export function captureFingerprint(baseFrontier: ItemFrontier, workingText: string): string {
  const frontier = baseFrontier
    .map(({ peer, counter }) => `${peer}:${counter}`)
    .sort()
    .join(",")
  return createHash("sha256").update(frontier).update("\n").update(workingText).digest("hex")
}

export function hasReceipt(doc: LoroDoc, fingerprint: string): boolean {
  if (!doc.hasContainer(cidRoot(RECEIPTS_NAME, "Map"))) return false
  return doc.getMap(RECEIPTS_NAME).get(doc.peerIdStr) === fingerprint
}

export function writeReceipt(doc: LoroDoc, fingerprint: string): void {
  doc.getMap(RECEIPTS_NAME).set(doc.peerIdStr, fingerprint)
}
