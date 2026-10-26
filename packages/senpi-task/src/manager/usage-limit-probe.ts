import type { ManagedChildEvent, ManagedChildHandle, RunnerOutcome } from "./child-handle"
import type { UsageLimitProbe } from "./usage-limit-memory"

function answered(event: ManagedChildEvent): boolean {
  if (event.type === "message_update") return true
  if (event.type !== "message_end" || typeof event.message !== "object" || event.message === null) return false
  const message = event.message as { readonly role?: unknown; readonly stopReason?: unknown }
  return message.role === "assistant" && message.stopReason !== "error"
}

/**
 * The outcome of the one same-provider rung an ambiguous usage limit hopped onto (#11383), bounded: a rung that has
 * not started answering within `timeoutMs` fails with the original limit plus the timeout, so a silent probe confirms
 * the provider's account limit instead of holding the task until the reset. `onAnswered` fires once the rung starts
 * answering, so its later failures are its own.
 */
export function boundedProbeOutcome(input: {
  readonly handle: ManagedChildHandle
  readonly probe: UsageLimitProbe
  readonly model: string
  readonly timeoutMs: number
  readonly onAnswered: () => void
}): Promise<RunnerOutcome> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop()
      resolve({
        status: "error",
        failure: {
          kind: "child-turn-failed",
          message: `${input.probe.message}\n${input.model} gave no answer within ${Math.ceil(input.timeoutMs / 1000)} s after that limit, so the ${input.probe.provider} limit counts as account-wide.`,
        },
      })
    }, input.timeoutMs)
    timer.unref?.()
    const stop = input.handle.subscribe((event) => {
      if (!answered(event)) return
      clearTimeout(timer)
      stop()
      input.onAnswered()
    })
    void input.handle.waitForOutcome().then(
      (outcome) => {
        clearTimeout(timer)
        stop()
        resolve(outcome)
      },
      (error: unknown) => {
        clearTimeout(timer)
        stop()
        reject(error)
      },
    )
  })
}
