import { log } from "@oh-my-opencode/utils"
import type { AdmissionParticipant, ResumeCredential } from "./admission-barrier"
import type { ObservedHold, RunPauseOwner, RunRef } from "./ports"
import { PauseRegistry, type PauseParticipant } from "./registry"

export type ResumeParticipantRequest = RunPauseOwner & {
  readonly resumeId: string
  readonly childSeqCutoff?: number
}

export type RunPauseEffects = {
  snapshot(parentSessionId: string, admissions: readonly AdmissionParticipant[]): readonly PauseParticipant[]
  quiesce(parentSessionId: string, pauseSeq: number): void | Promise<void>
  settleCreations?(parentSessionId: string, pauseSeq: number): Promise<void>
  addFences(parentSessionId: string, pauseSeq: number, runs: readonly RunRef[]): Promise<void>
  pause(participant: PauseParticipant, owner: RunPauseOwner): Promise<
    { readonly kind: "held"; readonly childSeq: number } | { readonly kind: "settled" } | { readonly kind: "pending" }>
  dispatchGuidance(parentSessionId: string, pauseSeq: number, resumeId: string): Promise<void>
  resume(participant: PauseParticipant, request: ResumeParticipantRequest, credential: ResumeCredential): Promise<
    { readonly kind: "resumed"; readonly turnId?: string } | { readonly kind: "held_by_user"; readonly childSeq: number }
    | { readonly kind: "settled" }>
  install(parentSessionId: string, pauseSeq: number, credential: ResumeCredential): Promise<void>
  acknowledgeInstalled(parentSessionId: string, pauseSeq: number, resumeId: string): Promise<void>
  cancel(participant: PauseParticipant, parentSessionId: string): Promise<void>
  // The child's engine view of this parent's hold; undefined when it reports none.
  observeHold?(participant: PauseParticipant, parentSessionId: string): Promise<ObservedHold | undefined>
}

type ResumeTransaction = { readonly pauseSeq: number; readonly resumeId: string; readonly credential: ResumeCredential }

export class RunPauseController {
  readonly #resuming = new Map<string, ResumeTransaction>()

  constructor(readonly registry: PauseRegistry, readonly effects: RunPauseEffects) {}

  async pause(parentSessionId: string, pauseSeq: number): Promise<void> {
    // Close before reading disk, enumerating children, or invoking any asynchronous effect.
    const admissions = this.registry.barrier.close(parentSessionId, pauseSeq)
    const prior = this.registry.load(parentSessionId)
    if (prior !== undefined && (prior.pauseSeq > pauseSeq || (prior.pauseSeq === pauseSeq && prior.phase !== "propagating"))) return
    this.#resuming.delete(parentSessionId)
    const record = prior?.pauseSeq === pauseSeq ? prior
      : this.registry.begin(parentSessionId, pauseSeq, this.effects.snapshot(parentSessionId, admissions))
    const quiesced = this.effects.quiesce(parentSessionId, pauseSeq)
    const runs = [...new Map(Object.values(record.participants).map(entry => [JSON.stringify(entry.runRef), entry.runRef])).values()]
    await this.effects.addFences(parentSessionId, pauseSeq, runs)
    await quiesced
    if (this.registry.require(parentSessionId).pauseSeq !== pauseSeq) return
    if (!await this.#propagate(parentSessionId, pauseSeq)) return
    await this.effects.settleCreations?.(parentSessionId, pauseSeq)
    if (this.registry.require(parentSessionId).pauseSeq !== pauseSeq) return
    if (!await this.#propagate(parentSessionId, pauseSeq)) return
    // A participant that never acknowledged is out of the run's custody; it must never hold the
    // Stop open, or neither Resume nor a person's message could reopen admission.
    for (const participant of Object.values(this.registry.require(parentSessionId).participants)) {
      if (participant.state === "held" || participant.state === "restorable" || participant.state === "lost") continue
      await this.#holdOrLose(parentSessionId, pauseSeq, participant, "never acknowledged the pause")
    }
    this.registry.phase(parentSessionId, pauseSeq, "applied")
  }

  // A Stop whose propagation failed may still be resumed past; the failure is kept as the reason
  // every participant that never acknowledged left the run's custody.
  recordPropagationFailure(parentSessionId: string, pauseSeq: number, error: unknown): void {
    const reason = `the Stop's propagation failed: ${error instanceof Error ? error.message : String(error)}`
    log("[senpi-task] run pause propagation failed", { parentSessionId, pauseSeq, reason })
    const record = this.registry.load(parentSessionId)
    if (record === undefined || record.pauseSeq !== pauseSeq) return
    for (const participant of Object.values(record.participants)) {
      if (participant.state !== "pending") continue
      this.registry.update(parentSessionId, pauseSeq, participant.key, { state: "lost", lostReason: reason })
    }
  }

  async resume(parentSessionId: string, pauseSeq: number, resumeId: string): Promise<{ readonly kind: "installed" | "superseded" }> {
    const requested = this.registry.requestResume(parentSessionId, pauseSeq, resumeId)
    await this.effects.dispatchGuidance(parentSessionId, pauseSeq, resumeId)
    const afterGuidance = this.registry.require(parentSessionId)
    if (afterGuidance.pauseSeq !== pauseSeq || afterGuidance.resume?.resumeId !== resumeId) return { kind: "superseded" }
    const credential = this.registry.authorizeResume(parentSessionId, pauseSeq, resumeId)
    const transaction = { pauseSeq, resumeId, credential }
    this.#resuming.set(parentSessionId, transaction)
    for (const participant of this.registry.orderedAdmissions(parentSessionId)) {
      if (!this.#current(parentSessionId, transaction)) return { kind: "superseded" }
      if (participant.state === "resumed") continue
      let cutoff = requested.childSeqCutoffs[participant.key]
      if (participant.state === "lost" || participant.state === "pending") {
        // A child outside the run's custody may still be held by its engine; release it rather
        // than strand it paused. One the engine does not hold is left as it is.
        const observed = await this.#observe(parentSessionId, participant)
        if (!this.#current(parentSessionId, transaction)) return { kind: "superseded" }
        if (observed?.held !== true) {
          const lostReason = participant.lostReason ?? "never acknowledged the pause"
          log("[senpi-task] run resume skips a lost participant", { parentSessionId, pauseSeq, key: participant.key, lostReason })
          if (participant.state === "pending") this.registry.update(parentSessionId, pauseSeq, participant.key, { state: "lost", lostReason })
          continue
        }
        cutoff = observed.childSeq
      }
      if (participant.kind !== "held_admission" && cutoff === undefined) throw new Error(`missing pause acknowledgement for ${participant.key}`)
      this.registry.update(parentSessionId, pauseSeq, participant.key, { state: "resuming" })
      const result = await this.effects.resume(participant, {
        parentSessionId, parentPauseSeq: pauseSeq, resumeId, runRef: participant.runRef,
        ...(cutoff === undefined ? {} : { childSeqCutoff: cutoff }),
      }, credential)
      if (!this.#current(parentSessionId, transaction)) return { kind: "superseded" }
      if (result.kind === "settled") this.registry.drop(parentSessionId, pauseSeq, participant.key)
      else if (result.kind === "held_by_user") this.registry.update(parentSessionId, pauseSeq, participant.key, {
        state: "held_by_user", observedChildSeq: result.childSeq,
      })
      else this.registry.update(parentSessionId, pauseSeq, participant.key, {
        state: "resumed", ...(result.turnId === undefined ? {} : { resumeTurnId: result.turnId }),
      })
    }
    await this.effects.install(parentSessionId, pauseSeq, credential)
    if (!this.#current(parentSessionId, transaction)) return { kind: "superseded" }
    await this.effects.acknowledgeInstalled(parentSessionId, pauseSeq, resumeId)
    const record = this.registry.require(parentSessionId)
    return record.pauseSeq === pauseSeq && record.resume?.resumeId === resumeId
      ? { kind: "installed" } : { kind: "superseded" }
  }

  released(parentSessionId: string, pauseSeq: number, resumeId: string): boolean {
    const transaction = this.#resuming.get(parentSessionId)
    if (transaction?.pauseSeq !== pauseSeq || transaction.resumeId !== resumeId) return false
    if (!this.registry.barrier.release(parentSessionId, transaction.credential)) return false
    this.registry.phase(parentSessionId, pauseSeq, "resumed")
    this.#resuming.delete(parentSessionId)
    return true
  }

  async cancel(parentSessionId: string, runRef: RunRef): Promise<void> {
    const selected = Object.values(this.registry.require(parentSessionId).participants)
      .filter(entry => JSON.stringify(entry.runRef) === JSON.stringify(runRef))
    for (const participant of selected) {
      await this.effects.cancel(participant, parentSessionId)
      const current = this.registry.require(parentSessionId)
      this.registry.drop(parentSessionId, current.pauseSeq, participant.key)
    }
  }

  async #propagate(parentSessionId: string, pauseSeq: number): Promise<boolean> {
    for (const key of Object.keys(this.registry.require(parentSessionId).participants)) {
      const record = this.registry.require(parentSessionId)
      if (record.pauseSeq !== pauseSeq) return false
      const participant = record.participants[key]
      if (participant === undefined || participant.state === "held" || participant.state === "restorable" || participant.state === "lost") continue
      if (participant.kind === "held_admission") {
        this.registry.update(parentSessionId, pauseSeq, key, { state: "held", ackSeq: pauseSeq })
        continue
      }
      let result: Awaited<ReturnType<RunPauseEffects["pause"]>> | { readonly kind: "lost"; readonly reason: string }
      try {
        result = await this.effects.pause(participant, { parentSessionId, parentPauseSeq: pauseSeq, runRef: participant.runRef })
      } catch (error) {
        result = { kind: "lost", reason: error instanceof Error ? error.message : String(error) }
      }
      if (this.registry.require(parentSessionId).pauseSeq !== pauseSeq) return false
      if (result.kind === "lost") await this.#holdOrLose(parentSessionId, pauseSeq, participant, result.reason)
      else if (result.kind === "settled") this.registry.drop(parentSessionId, pauseSeq, key)
      else if (result.kind === "held") this.registry.update(parentSessionId, pauseSeq, key, {
        state: "held", ackSeq: pauseSeq, observedChildSeq: result.childSeq,
      })
    }
    return true
  }

  #observe(parentSessionId: string, participant: PauseParticipant): Promise<ObservedHold | undefined> {
    return this.effects.observeHold?.(participant, parentSessionId).catch((error: unknown) => {
      log("[senpi-task] run hold observation failed", { parentSessionId, key: participant.key, error: error instanceof Error ? error.message : String(error) })
      return undefined
    }) ?? Promise.resolve(undefined)
  }

  // Only a child its engine does not hold is lost: a failed pause request can land after the hold.
  async #holdOrLose(parentSessionId: string, pauseSeq: number, participant: PauseParticipant, reason: string): Promise<void> {
    const observed = await this.#observe(parentSessionId, participant)
    if (this.registry.require(parentSessionId).pauseSeq !== pauseSeq) return
    if (observed?.held === true) {
      this.registry.update(parentSessionId, pauseSeq, participant.key, { state: "held", ackSeq: pauseSeq, observedChildSeq: observed.childSeq })
      return
    }
    log("[senpi-task] run pause lost a participant", { parentSessionId, pauseSeq, key: participant.key, reason })
    this.registry.update(parentSessionId, pauseSeq, participant.key, { state: "lost", lostReason: reason })
  }

  #current(parentSessionId: string, transaction: ResumeTransaction): boolean {
    const state = this.registry.barrier.state(parentSessionId)
    return this.#resuming.get(parentSessionId) === transaction && state.kind === "resuming"
      && state.pauseSeq === transaction.pauseSeq && state.resumeId === transaction.resumeId
      && this.registry.require(parentSessionId).pauseSeq === transaction.pauseSeq
  }
}
