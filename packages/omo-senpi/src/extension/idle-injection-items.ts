import type { RunRef } from "../../../senpi-task/src/pause/ports"
import type { IdleInjection, IdleInjectionMessage } from "./idle-injection-coordinator"

export type AdmissionItem = {
  readonly itemId: string
  readonly producer: string
  readonly content: string
  readonly runRef?: RunRef
  readonly customType?: string
  readonly details?: unknown
  readonly display?: boolean
  readonly contextScoped?: boolean
}

export type ItemReceipt = {
  readonly itemId: string
  readonly disposition: "notice_persisted" | "message_persisted"
  readonly entryId: string
  readonly noticeId?: string
}

export type QueuedInjection = IdleInjection & { readonly itemId: string }

// One flush is ONE delivery (one model turn at most): every item rides it with its own identity and
// run reference, and the engine decides custody per item at admission (design 4.5).
export function admissionBatches(injections: readonly QueuedInjection[]) {
  return [injections].filter(group => group.length > 0).map(group => ({
    injections: group,
    message: batchMessage(group),
    items: group.map(({ itemId, source, content, runRef, customType, details, display, contextScoped }): AdmissionItem => ({
      itemId, producer: source, content,
      ...(runRef === undefined ? {} : { runRef }),
      ...(customType === undefined ? {} : { customType }),
      ...(details === undefined ? {} : { details }),
      ...(display === undefined ? {} : { display }),
      ...(contextScoped === undefined ? {} : { contextScoped }),
    })),
  }))
}

// The batch's one message still carries every item's text: a delivery that sends the message (not the
// itemized items) must deliver the whole wake, with each context-scoped segment's range intact.
function batchMessage(group: readonly QueuedInjection[]): IdleInjectionMessage {
  let offset = 0
  const details = group.flatMap(item => {
    const start = offset
    const end = start + item.content.length
    offset = end + 2
    return item.customType === undefined ? [] : [{
      customType: item.customType, details: item.details,
      ...(item.contextScoped === true ? { contentRange: [start, end] as const } : {}),
    }]
  })
  return { customType: "omo-senpi:wake", content: group.map(item => item.content).join("\n\n"), display: false, details }
}

export function settleItemReceipts(injections: readonly QueuedInjection[], result: unknown): void {
  // A host with no custody receipts retains its synchronous successful-send contract.
  if (result === undefined || !Array.isArray(result)) {
    for (const injection of injections) injection.onFlushed?.()
    return
  }
  for (const injection of injections) {
    const receipt: unknown = result.find(value => isReceipt(value) && value.itemId === injection.itemId)
    if (!isReceipt(receipt)) {
      injection.onDeliveryFailed?.(new Error(`missing custody receipt for ${injection.itemId}`))
    } else if (receipt.disposition === "notice_persisted") {
      injection.onHeld?.(receipt)
    } else {
      injection.onFlushed?.()
    }
  }
}

function isReceipt(value: unknown): value is ItemReceipt {
  return typeof value === "object" && value !== null && "itemId" in value && typeof value.itemId === "string"
    && "entryId" in value && typeof value.entryId === "string" && "disposition" in value
    && (value.disposition === "notice_persisted" || value.disposition === "message_persisted")
}
