// The capture entry point (review r4): every capture runs on a device doc and keys its
// idempotency on (device peer, item, baseline frontier), never on the working text.
// - Working text equal to the current render is not an edit: no ops, and the render is
//   receipted for the baseline so later typing at that baseline diffs from it.
// - A receipted baseline diffs from the receipted text at the receipted frontier; the user's
//   typing since then is carried onto that state by a three-way merge. The edit already
//   applied under the identity is therefore never applied twice.
// - The receipt is written before the update is returned, and is trusted only once the doc
//   contains its frontier, so a crash before import leaves the baseline diff in force.
// recordMaterialized is the engine's half: it receipts the text it writes to disk before the
// write, so a crash between writing the file and saving the baseline cannot re-apply synced text.

import type { LoroDoc } from "../../crdt/loro-runtime"

import { captureItem } from "./capture"
import type { CaptureReceipt } from "./capture-receipts"
import { containsFrontier, readReceipts, sameFrontier, writeReceipts } from "./capture-receipts"
import type { ItemDevice } from "./device"
import { assertDeviceDoc } from "./device"
import type { ItemFrontier } from "./document"
import { isLive } from "./document"
import { renderDocContent } from "./render"
import { mergeText } from "./three-way"

export async function captureOnDevice(
  device: ItemDevice,
  itemKey: string,
  doc: LoroDoc,
  baseText: string,
  baseFrontier: ItemFrontier,
  workingText: string,
): Promise<Uint8Array | null> {
  assertDeviceDoc(device, doc)
  const receipts = await readReceipts(device.stateDir, itemKey)
  if (isLive(doc) && workingText === renderDocContent(doc)) {
    await receipt(device, itemKey, receipts, baseFrontier, workingText, doc.frontiers())
    return null
  }
  const prior = receipts.find((r) => sameFrontier(r.base, baseFrontier) && containsFrontier(doc, r.at))
  const plan = prior === undefined ? { baseText, baseFrontier, workingText } : await resume(doc, prior, workingText)
  const update = captureItem(doc, plan.baseText, plan.baseFrontier, plan.workingText)
  if (update === null) return null
  await receipt(device, itemKey, receipts, baseFrontier, workingText, frontierAfter(doc, update))
  return update
}

export async function recordMaterialized(
  device: ItemDevice,
  itemKey: string,
  doc: LoroDoc,
  baseFrontier: ItemFrontier,
  writtenText: string,
): Promise<void> {
  assertDeviceDoc(device, doc)
  const receipts = await readReceipts(device.stateDir, itemKey)
  await receipt(device, itemKey, receipts, baseFrontier, writtenText, doc.frontiers())
}

async function resume(
  doc: LoroDoc,
  prior: CaptureReceipt,
  workingText: string,
): Promise<{ baseText: string; baseFrontier: ItemFrontier; workingText: string }> {
  const at = doc.forkAt(prior.at)
  try {
    const applied = renderDocContent(at)
    return { baseText: applied, baseFrontier: prior.at, workingText: await mergeText(prior.text, workingText, applied) }
  } finally {
    at.free()
  }
}

function frontierAfter(doc: LoroDoc, update: Uint8Array): ItemFrontier {
  const probe = doc.fork()
  try {
    probe.import(update)
    return probe.frontiers()
  } finally {
    probe.free()
  }
}

function receipt(
  device: ItemDevice,
  itemKey: string,
  receipts: readonly CaptureReceipt[],
  base: ItemFrontier,
  text: string,
  at: ItemFrontier,
): Promise<void> {
  const kept = receipts.filter((r) => !sameFrontier(r.base, base))
  return writeReceipts(device.stateDir, itemKey, [...kept, { base, text, at }])
}
