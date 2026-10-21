import type { NativeItemMessage } from "../src/extension/deliver-items"
import type { IdleInjectionMessage } from "../src/extension/idle-injection-coordinator"

// A test engine may coalesce only AFTER each native message has crossed its admission boundary.
export function coalesceAdmittedWake(messages: readonly NativeItemMessage[]): IdleInjectionMessage {
  let offset = 0
  const details: { customType: string; details: unknown; contentRange?: readonly [number, number] }[] = []
  for (const message of messages) {
    for (const detail of message.details.items) details.push({
      ...detail,
      details: detail.details,
      ...(detail.contentRange === undefined ? {} : {
        contentRange: [detail.contentRange[0] + offset, detail.contentRange[1] + offset] as const,
      }),
    })
    offset += message.content.length + 2
  }
  return { customType: "omo-senpi:wake", content: messages.map(message => message.content).join("\n\n"), display: false, details }
}
