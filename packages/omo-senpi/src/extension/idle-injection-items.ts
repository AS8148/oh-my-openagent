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
  readonly disposition: "notice_persisted" | "model_consumed"
  readonly entryId: string
}

export type QueuedInjection = IdleInjection & { readonly itemId: string }

export function admissionBatches(injections: readonly QueuedInjection[]) {
  const groups = new Map<string, QueuedInjection[]>()
  for (const injection of injections) {
    const ref = JSON.stringify(injection.runRef)
    const group = groups.get(ref) ?? []
    group.push(injection)
    groups.set(ref, group)
  }
  return [...groups.values()].map(group => ({
    injections: group,
    message: {
      customType: "omo-senpi:wake",
      content: "",
      display: false,
      details: group.flatMap(item => item.customType === undefined ? [] : [{
        customType: item.customType, details: item.details,
      }]),
    } satisfies IdleInjectionMessage,
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
    && (value.disposition === "notice_persisted" || value.disposition === "model_consumed")
}
