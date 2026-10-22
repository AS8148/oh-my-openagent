import type { EnginePauseState } from "../../../../senpi-task/src/pause/ports"
import type { RunPauseController } from "../../../../senpi-task/src/pause/run-controller"
import { readEngineRunHold } from "./engine-hold-reader"

export type RunHoldChange = EnginePauseState & { readonly change: "paused" | "resumed" }

export class EngineRunPauseBridge {
  readonly #pauses = new Map<string, { readonly seq: number; readonly pending: Promise<void> }>()
  readonly #resumes = new Map<string, { readonly seq: number; readonly pending: Promise<void> }>()

  constructor(
    readonly controller: RunPauseController,
    readonly native: { getPauseState(): EnginePauseState | undefined },
    readonly afterReleased?: (parentSessionId: string) => void | Promise<void>,
  ) {}

  async restore(parentSessionId: string): Promise<void> {
    const registry = this.controller.registry
    const persisted = registry.load(parentSessionId)
    const state = this.native.getPauseState()
    const live = state === undefined ? undefined : readEngineRunHold(state)
    if (persisted === undefined && live?.stopped !== true) return
    const pauseSeq = Math.max(persisted?.pauseSeq ?? 0, live?.pauseSeq ?? 0)
    registry.restore(parentSessionId, {
      pauseSeq,
      rebuild: () => this.controller.effects.snapshot(parentSessionId, registry.barrier.inFlight(parentSessionId)),
    })
  }

  async reconciled(parentSessionId: string): Promise<void> {
    const registry = this.controller.registry
    const record = registry.load(parentSessionId)
    if (record === undefined) return
    const state = this.native.getPauseState()
    if (state === undefined) return
    const live = readEngineRunHold(state)
    const pauseSeq = record.pauseSeq
    if (record.phase === "resumed" && !live.stopped) return
    // Only an authoritative engine ledger at this epoch proves that the user's Stop
    // was released. An absent/old context must not turn a restart into Resume.
    if (!live.stopped && live.pauseSeq === pauseSeq) return this.#resume(parentSessionId, pauseSeq)
    await this.#pause(parentSessionId, pauseSeq)
  }

  changed(parentSessionId: string, event: RunHoldChange): Promise<void> {
    const state = this.native.getPauseState()
    if (state !== undefined && state.pauseSeq > event.pauseSeq) return Promise.resolve()
    const live = readEngineRunHold(event)
    if (event.change === "paused" && live.stopped) return this.#pause(parentSessionId, event.pauseSeq)
    if (event.change === "resumed" && !live.stopped) return this.#resume(parentSessionId, event.pauseSeq)
    return Promise.resolve()
  }

  #pause(parentSessionId: string, pauseSeq: number): Promise<void> {
    const existing = this.#pauses.get(parentSessionId)
    if (existing?.seq === pauseSeq) return existing.pending
    const pending = this.controller.pause(parentSessionId, pauseSeq)
    const entry = { seq: pauseSeq, pending }
    this.#pauses.set(parentSessionId, entry)
    void pending.catch(() => { if (this.#pauses.get(parentSessionId) === entry) this.#pauses.delete(parentSessionId) })
    // Keep the fulfilled propagation promise until the next Stop so a Resume racing
    // the final acknowledgement observes the same completed transaction.
    return pending
  }

  #resume(parentSessionId: string, pauseSeq: number): Promise<void> {
    const existing = this.#resumes.get(parentSessionId)
    if (existing?.seq === pauseSeq) return existing.pending
    const pending = this.#resumeAfterPropagation(parentSessionId, pauseSeq)
    const entry = { seq: pauseSeq, pending }
    this.#resumes.set(parentSessionId, entry)
    void pending.catch(() => { if (this.#resumes.get(parentSessionId) === entry) this.#resumes.delete(parentSessionId) })
    return pending
  }

  async #resumeAfterPropagation(parentSessionId: string, pauseSeq: number): Promise<void> {
    const registry = this.controller.registry
    const before = registry.load(parentSessionId)
    if (before === undefined || before.pauseSeq !== pauseSeq || before.phase === "resumed") return
    // Resume still runs after a failed propagation, so admission reopens; the failure is logged and
    // kept as the reason each unacknowledged participant left the run's custody.
    await this.#pause(parentSessionId, pauseSeq).catch((error: unknown) => {
      this.controller.recordPropagationFailure(parentSessionId, pauseSeq, error)
    })
    const record = registry.require(parentSessionId)
    if (record.pauseSeq !== pauseSeq) return
    const resumeId = record.resume?.resumeId ?? `parent-resume:${pauseSeq}`
    const installed = await this.controller.resume(parentSessionId, pauseSeq, resumeId)
    if (installed.kind === "installed" && this.controller.released(parentSessionId, pauseSeq, resumeId)) await this.afterReleased?.(parentSessionId)
  }
}

export function isRunHoldChange(value: unknown): value is RunHoldChange {
  if (typeof value !== "object" || value === null) return false
  if (!("pauseSeq" in value) || !Number.isSafeInteger(value.pauseSeq) || typeof value.pauseSeq !== "number" || value.pauseSeq < 1) return false
  if (!("change" in value) || (value.change !== "paused" && value.change !== "resumed")) return false
  return "holds" in value && Array.isArray(value.holds) && value.holds.every(hold =>
    typeof hold === "object" && hold !== null && "kind" in hold && typeof hold.kind === "string"
    && "key" in hold && typeof hold.key === "string")
}
