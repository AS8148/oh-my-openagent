import { PostHog, type PostHogOptions } from "posthog-node"

import type { TelemetryCaptureMessage } from "./types"

// 400 (malformed batch) and 413 (too large) are answers about the event itself: sending the same bytes
// again can never succeed. Every other failure (5xx, 408, 429, other 4xx, network, timeout) is retryable.
const PERMANENT_STATUSES: ReadonlySet<number> = new Set([400, 413])

/** A send the server did not accept. `permanent` means a retry of the same event can never succeed. */
export class TelemetryDeliveryError extends Error {
  readonly permanent: boolean
  readonly status: number | undefined

  constructor(status: number | undefined, cause?: unknown) {
    super(status === undefined ? "telemetry event was not delivered (no response)" : `telemetry event was rejected with HTTP ${status}`, { cause })
    this.name = "TelemetryDeliveryError"
    this.status = status
    this.permanent = status !== undefined && PERMANENT_STATUSES.has(status)
  }
}

type Attempt = { status?: number; error?: unknown }
type Fetch = NonNullable<PostHogOptions["fetch"]>

/**
 * posthog-node's captureImmediate resolves even when the request failed (it reports the failure on its
 * `error` event), so it cannot tell a delivered event from a lost one. This sender owns a dedicated client
 * whose fetch records each answer, runs one send at a time so every answer belongs to the current send, and
 * never retries inside the process: an undelivered event stays queued on disk and is retried later.
 */
export function createImmediateSender(apiKey: string, options: PostHogOptions): {
  readonly send: (message: TelemetryCaptureMessage) => Promise<void>
  readonly shutdown: () => Promise<void>
} {
  const baseFetch: Fetch = options.fetch ?? ((url, init) => fetch(url, init))
  let current: Attempt | undefined
  const trackedFetch: Fetch = async (url, init) => {
    const attempt = current
    try {
      const response = await baseFetch(url, init)
      if (attempt !== undefined) attempt.status = response.status
      return response
    } catch (error) {
      if (attempt !== undefined) attempt.error = error
      throw error
    }
  }
  const client = new PostHog(apiKey, { ...options, fetch: trackedFetch, fetchRetryCount: 0 })
  let queue: Promise<unknown> = Promise.resolve()

  const sendOne = async (message: TelemetryCaptureMessage): Promise<void> => {
    const attempt: Attempt = {}
    current = attempt
    try {
      await client.captureImmediate(message)
    } finally {
      current = undefined
    }
    const { status } = attempt
    if (status === undefined || status < 200 || status >= 300) throw new TelemetryDeliveryError(status, attempt.error)
  }

  return {
    send(message) {
      const result = queue.then(() => sendOne(message))
      queue = result.catch(() => undefined)
      return result
    },
    async shutdown() {
      await client.shutdown()
    },
  }
}
