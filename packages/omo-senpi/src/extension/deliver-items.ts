import type { RunRef } from "../../../senpi-task/src/pause/ports"
import type { AdmissionItem, ItemReceipt } from "./idle-injection-items"

export type NativeItemMessage = {
  readonly customType: "omo-senpi:wake"
  readonly content: string
  readonly display: false
  readonly details: {
    readonly itemId: string
    readonly runRef?: RunRef
    readonly items: readonly {
      readonly customType: string
      readonly details?: unknown
      readonly contentRange?: readonly [number, number]
    }[]
  }
}

type NativeSender = (
  message: NativeItemMessage,
  options: { readonly triggerTurn: true; readonly deliverAs: "steer" | "followUp" },
) => void | ItemReceipt | Promise<void | ItemReceipt>

// Current engines admit one custom message at a time. Keep the items independent all the way
// through that call: details.runRef is the native run-fence selector, not an option on sendMessage.
export function deliverItems(
  send: NativeSender,
  options: { readonly items: readonly AdmissionItem[]; readonly deliverAs: "steer" | "followUp" },
): Promise<readonly ItemReceipt[] | undefined> {
  const results = options.items.map(item => send({
    customType: "omo-senpi:wake",
    content: item.content,
    display: false,
    details: {
      itemId: item.itemId,
      ...(item.runRef === undefined ? {} : { runRef: item.runRef }),
      items: item.customType === undefined ? [] : [{
        customType: item.customType,
        ...(item.details === undefined ? {} : { details: item.details }),
        ...(item.contextScoped === true ? { contentRange: [0, item.content.length] as const } : {}),
      }],
    },
  }, { triggerTurn: true, deliverAs: options.deliverAs }))
  return Promise.all(results).then(delivered => {
    const receipts = delivered.filter((receipt): receipt is ItemReceipt => receipt !== undefined)
    return receipts.length === 0 ? undefined : receipts
  })
}
