import type { InFlightReads } from "@oh-my-opencode/memory-core"

import type { SenpiExtensionAPI } from "../../extension/types"

type MemoryHook = Parameters<SenpiExtensionAPI["on"]>[1]

// The shutdown drain waits on the tracked work, so a tracked session_shutdown handler would wait on itself.
const UNTRACKED_EVENTS: ReadonlySet<string> = new Set(["session_shutdown"])

/**
 * The extension API the memory component registers through: every hook handler it adds (session_shutdown aside) has
 * its returned promise tracked in `work`, which the session_shutdown drain awaits. A hook still reading the identity
 * repository when the session shuts down is then waited on instead of leaving a git child in that directory (#11135).
 */
export function trackMemoryHooks<Api extends SenpiExtensionAPI>(pi: Api, work: InFlightReads): Api {
  const on: SenpiExtensionAPI["on"] = (event, handler, options) => {
    pi.on(event, UNTRACKED_EVENTS.has(event) ? handler : trackedHook(handler, work), options)
  }
  return new Proxy(pi, {
    get(target, key) {
      if (key === "on") return on
      const value: unknown = Reflect.get(target, key, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

function trackedHook(handler: MemoryHook, work: InFlightReads): MemoryHook {
  return function trackedMemoryHook(payload, ctx, observer) {
    const result = handler(payload, ctx, observer)
    if (result instanceof Promise) void work.track(() => result)
    return result
  }
}
