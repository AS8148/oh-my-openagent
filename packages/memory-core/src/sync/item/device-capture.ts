// The capture entry point (review r4): every capture runs on a device doc and keys its
// idempotency on (device peer, item, baseline frontier), never on the working text.
// - Working text equal to the current render is not an edit: no ops, and the render is
//   receipted for the baseline so later typing at that baseline diffs from it.
// - A receipted baseline diffs from the receipted text at the receipted frontier; the user's
//   typing since then is carried onto that state by a per-field merge on the item model
//   (field-merge.ts), and register writes supersede only the values the user saw. The edit
//   already applied under the identity is therefore never applied twice, and no register
//   value is ever spliced from serialized text.
// - The receipt is written before the update is returned, and is trusted only once the doc
//   contains its frontier, so a crash before import leaves the baseline diff in force.
// recordMaterialized is the engine's half: it receipts the text it writes to disk before the
// write, so a crash between writing the file and saving the baseline cannot re-apply synced text.
// Captures of one item run one at a time in this process; the engine must not run two
// processes against one state dir (receipts are a read-modify-write).

import type { LoroDoc } from "../../crdt/loro-runtime"

import { captureItem } from "./capture"
import type { CaptureReceipt } from "./capture-receipts"
import { readReceipts, receiptLanded, sameFrontier, stampsOf, writeReceipts } from "./capture-receipts"
import type { ItemDevice } from "./device"
import { assertDeviceDoc } from "./device"
import type { ItemFrontier } from "./document"
import { isLive } from "./document"
import { renderDocContent } from "./render"
import { mergeFields } from "./field-merge"
import { BODY_NAME } from "./state"

export async function captureOnDevice(
  device: ItemDevice,
  itemKey: string,
  doc: LoroDoc,
  baseText: string,
  baseFrontier: ItemFrontier,
  workingText: string,
): Promise<Uint8Array | null> {
  assertDeviceDoc(device, doc)
  return serialized(`${device.stateDir}\0${itemKey}`, async () => {
    const receipts = await readReceipts(device.stateDir, itemKey)
    if (isLive(doc) && workingText === renderDocContent(doc)) {
      await receipt(device, itemKey, receipts, baseFrontier, workingText, doc)
      return null
    }
    const prior = receipts.find((r) => sameFrontier(r.base, baseFrontier) && receiptLanded(doc, r))
    const plan =
      prior === undefined
        ? { baseText, baseFrontier, workingText, unseen: new Set<string>() }
        : await resume(device, doc, prior, workingText)
    const update = captureItem(doc, plan.baseText, plan.baseFrontier, plan.workingText, plan.unseen)
    if (update === null) return null
    const after = doc.fork()
    try {
      after.import(update)
      await receipt(device, itemKey, receipts, baseFrontier, workingText, after)
    } finally {
      after.free()
    }
    return update
  })
}

export async function recordMaterialized(
  device: ItemDevice,
  itemKey: string,
  doc: LoroDoc,
  baseFrontier: ItemFrontier,
  writtenText: string,
): Promise<void> {
  assertDeviceDoc(device, doc)
  await serialized(`${device.stateDir}\0${itemKey}`, async () => {
    const receipts = await readReceipts(device.stateDir, itemKey)
    await receipt(device, itemKey, receipts, baseFrontier, writtenText, doc)
  })
}

interface Plan {
  readonly baseText: string
  readonly baseFrontier: ItemFrontier
  readonly workingText: string
  readonly unseen: ReadonlySet<string>
}

async function resume(device: ItemDevice, doc: LoroDoc, prior: CaptureReceipt, workingText: string): Promise<Plan> {
  const at = doc.forkAt(prior.at)
  const base = doc.forkAt(prior.base)
  try {
    const applied = renderDocContent(at)
    const seen = registerTags(base)
    const unseen = new Set([...registerTags(at)].filter((tag) => !seen.has(tag) && !tag.startsWith(`${device.peer}@`)))
    return { baseText: applied, baseFrontier: prior.at, workingText: await mergeFields(prior.text, workingText, applied), unseen }
  } finally {
    at.free()
    base.free()
  }
}

function registerTags(doc: LoroDoc): Set<string> {
  const tags = new Set<string>()
  for (const name of Object.keys(doc.getShallowValue())) {
    if (name === BODY_NAME || !name.startsWith("fm\x1f") || !name.endsWith("\x1freg")) continue
    for (const tag of doc.getMap(name).keys()) tags.add(tag)
  }
  return tags
}

function receipt(
  device: ItemDevice,
  itemKey: string,
  receipts: readonly CaptureReceipt[],
  base: ItemFrontier,
  text: string,
  landed: LoroDoc,
): Promise<void> {
  const kept = receipts.filter((r) => !sameFrontier(r.base, base))
  const at = landed.frontiers()
  return writeReceipts(device.stateDir, itemKey, [...kept, { base, text, at, stamps: stampsOf(landed, at) }])
}

const queues = new Map<string, Promise<unknown>>()

async function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.then(run, run)
  const settled = next.then(
    () => undefined,
    () => undefined,
  )
  queues.set(key, settled)
  try {
    return await next
  } finally {
    if (queues.get(key) === settled) queues.delete(key)
  }
}
