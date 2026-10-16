import { join } from "node:path"

import { postWithRetry, type OtlpFetch } from "./otlp-http"
import {
  claimBatch,
  deleteFile,
  dropFile,
  oldestSealedBatches,
  quarantineFile,
  releaseClaim,
  renewClaim,
  type SpoolContext,
} from "./otlp-spool-dir"
import { readSpoolRequest } from "./otlp-spool-file"
import type { TelemetryDiagnosticEvent } from "./types"

const LEASE_RENEW_MS = 60_000

export type BatchSenderInput = {
  readonly ctx: SpoolContext
  readonly endpoint: string
  readonly ingestKey: string
  readonly fetch: OtlpFetch
  readonly sleep: (ms: number, abort: AbortSignal) => Promise<void>
  readonly random: () => number
  readonly consent: () => boolean
  readonly onAccepted: (sealedName: string) => void
  readonly report: (event: TelemetryDiagnosticEvent, error?: unknown) => void
}

/**
 * Sends sealed batches oldest first, one file per request, each under a renamed claim with a lease.
 * A file whose send must be retried later is skipped until the next flush, so an outage never spins.
 */
export class BatchSender {
  readonly #input: BatchSenderInput
  readonly #abort = new AbortController()
  readonly #deferred = new Set<string>()
  #pumping: Promise<void> | null = null
  #rerun = false
  #inFlight: string | undefined
  #stopped = false

  constructor(input: BatchSenderInput) {
    this.#input = input
  }

  newCycle(): void {
    this.#deferred.clear()
  }

  pump(): Promise<void> {
    if (this.#pumping !== null) {
      this.#rerun = true
      return this.#pumping
    }
    this.#pumping = (async () => {
      do {
        this.#rerun = false
        await this.#pass()
      } while (this.#rerun && !this.#stopped)
    })().finally(() => {
      this.#pumping = null
    })
    return this.#pumping
  }

  stop(): void {
    this.#stopped = true
    this.#abort.abort()
    const inFlight = this.#inFlight
    if (inFlight === undefined) return
    try {
      releaseClaim(this.#input.ctx, inFlight)
    } catch (error) {
      this.#input.report("telemetry_otlp_send_failed", error)
    }
  }

  async #pass(): Promise<void> {
    const ctx = this.#input.ctx
    while (!this.#stopped && this.#input.consent()) {
      let next: ReturnType<typeof oldestSealedBatches>[number] | undefined
      try {
        next = oldestSealedBatches(ctx.dir).find((entry) => !this.#deferred.has(entry.batchId))
      } catch (error) {
        this.#input.report("telemetry_spool_sweep_failed", error)
        return
      }
      if (next === undefined) return
      this.#deferred.add(next.batchId)
      const claimed = claimBatch(ctx, next)
      if (claimed !== null) await this.#send(claimed, next.name)
    }
  }

  async #send(claimed: string, sealedName: string): Promise<void> {
    const ctx = this.#input.ctx
    this.#inFlight = claimed
    const renew = setInterval(() => {
      const current = this.#inFlight
      const renewed = current === undefined ? null : renewClaim(ctx, current)
      if (renewed !== null) this.#inFlight = renewed
    }, LEASE_RENEW_MS)
    renew.unref?.()
    try {
      const request = readSpoolRequest(join(ctx.dir, claimed))
      if (request.kind === "corrupt") {
        quarantineFile(ctx, claimed)
        return
      }
      const outcome = await postWithRetry({
        fetch: this.#input.fetch,
        sleep: this.#input.sleep,
        random: this.#input.random,
        endpoint: this.#input.endpoint,
        ingestKey: this.#input.ingestKey,
        abort: this.#abort.signal,
      }, request.signal, request.body)
      const current = this.#inFlight ?? claimed
      if (outcome.kind === "accepted") {
        deleteFile(ctx.dir, current)
        this.#input.onAccepted(sealedName)
        if (outcome.partial !== undefined && outcome.partial.rejected > 0) {
          this.#input.report("telemetry_otlp_partial_success", new Error(outcome.partial.message))
        }
      } else if (outcome.kind === "rejected") {
        dropFile(ctx, current, "rejected")
      } else if (!this.#stopped) {
        releaseClaim(ctx, current)
        if (outcome.kind === "retry_later") this.#input.report("telemetry_otlp_send_failed")
      }
    } catch (error) {
      this.#input.report("telemetry_otlp_send_failed", error)
      try {
        releaseClaim(ctx, this.#inFlight ?? claimed)
      } catch (releaseError) {
        this.#input.report("telemetry_otlp_send_failed", releaseError)
      }
    } finally {
      clearInterval(renew)
      this.#inFlight = undefined
    }
  }
}
