// Capture receipts (review r4 HIGH): a capture's identity is (device peer, item, baseline
// frontier). The receipt for that identity records the working text already applied and the
// frontier the capture produced. A later capture with the same identity diffs from the
// receipt's text at the receipt's frontier instead of from the baseline, so an edit applied
// under an identity is never applied again, whatever the user typed since.
// Receipts are per-device state (the device's state dir, never a synced root) and are only
// trusted when the document contains the receipt's frontier: a receipt written for an update
// that was never imported (crash before import) is ignored and the baseline diff applies.
// Each item keeps the newest MAX_RECEIPTS baselines; the engine has at most two in flight.

import { createHash, randomBytes } from "node:crypto"
import { join } from "node:path"

import type { LoroDoc } from "../../crdt/loro-runtime"
import { mkdir, readFile, rename, writeFile } from "../../fs/resilient"

import type { ItemFrontier } from "./document"

export interface CaptureReceipt {
  readonly base: ItemFrontier
  readonly text: string
  readonly at: ItemFrontier
}

export const MAX_RECEIPTS = 32

function receiptPath(stateDir: string, itemKey: string): string {
  return join(stateDir, "captures", `${createHash("sha256").update(itemKey).digest("hex")}.json`)
}

export async function readReceipts(stateDir: string, itemKey: string): Promise<CaptureReceipt[]> {
  let raw: string
  try {
    raw = await readFile(receiptPath(stateDir, itemKey), "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
    throw error
  }
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new TypeError(`capture receipts are not a list: ${itemKey}`)
  return parsed.map((entry) => asReceipt(entry, itemKey))
}

export async function writeReceipts(stateDir: string, itemKey: string, receipts: readonly CaptureReceipt[]): Promise<void> {
  const path = receiptPath(stateDir, itemKey)
  await mkdir(join(stateDir, "captures"), { recursive: true })
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  await writeFile(temp, JSON.stringify(receipts.slice(-MAX_RECEIPTS)), { flag: "wx", mode: 0o600 })
  await rename(temp, path)
}

export function sameFrontier(a: ItemFrontier, b: ItemFrontier): boolean {
  return a.length === b.length && a.every((x) => b.some((y) => x.peer === y.peer && x.counter === y.counter))
}

export function containsFrontier(doc: LoroDoc, frontier: ItemFrontier): boolean {
  const version = doc.oplogVersion().toJSON()
  return frontier.every(({ peer, counter }) => (version.get(peer) ?? 0) > counter)
}

function asReceipt(entry: unknown, itemKey: string): CaptureReceipt {
  if (typeof entry === "object" && entry !== null && "base" in entry && "text" in entry && "at" in entry) {
    const { base, text, at } = entry
    if (typeof text === "string" && isFrontier(base) && isFrontier(at)) return { base, text, at }
  }
  throw new TypeError(`malformed capture receipt: ${itemKey}`)
}

function isFrontier(value: unknown): value is ItemFrontier {
  return (
    Array.isArray(value) &&
    value.every(
      (id: unknown) =>
        typeof id === "object" &&
        id !== null &&
        "peer" in id &&
        "counter" in id &&
        typeof id.peer === "string" &&
        /^[0-9]+$/.test(id.peer) &&
        typeof id.counter === "number",
    )
  )
}
