import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { withLock } from "@oh-my-opencode/team-core/team-state-store/locks"
import { credentialId, type CredentialStore } from "./keystore"
import {
  ApiRefusal, type ChooseDevice, type Credentials, deviceListSchema, jsonRequest,
  parseReply, requestApi, RequestFailure, serviceOrigin, SignInError, tokenSchema,
} from "./protocol"

class SessionEnded extends SignInError {
  constructor(message: string, readonly deviceRevoked: boolean) { super(message) }
}

// The service revokes the device row before answering reauth_required on refresh (token reuse);
// account_deleted removes the account. unauthorized and invalid_grant leave the device's slot held.
const DEVICE_REVOKING_REFUSALS = new Set(["account_deleted", "reauth_required", "device_revoked"])
// A refusal the service gives before it reads the token proves the token was not consumed.
const UNCONSUMED_REFUSALS = new Set(["invalid_request"])
const MAX_RETRY_DELAY = 300_000
const retryDelay = (attempts: number) => Math.min(MAX_RETRY_DELAY, 5_000 * 2 ** (attempts - 1))
// The service contract (1.21.0) requires a CSPRNG key of at least 256 bits as 43..128 base64url chars.
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{43,128}$/
const newIdempotencyKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")

export function createSession(options: {
  readonly api: string
  readonly store: CredentialStore
  readonly home?: string
  readonly signal?: AbortSignal
  readonly now?: () => number
}) {
  const api = serviceOrigin(options.api)
  const now = options.now ?? Date.now
  const { store, signal } = options
  const directory = join(options.home ?? homedir(), ".omo", "session-locks")
  const lockPath = join(directory, `${credentialId(api)}.lock`)
  async function locked<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    signal?.throwIfAborted()
    return withLock(lockPath, async () => {
      signal?.throwIfAborted()
      return action()
    }, { ownerTag: "cli-session", staleAfterMs: Number.POSITIVE_INFINITY })
  }
  const request = (path: string, init: RequestInit) => requestApi(api, path, init, signal)
  const uncertain = () => new SignInError(
    "The refresh outcome is unknown. Saved credentials and keys were retained, and the same refresh will be retried automatically.", true)
  async function refreshedAccess(current: Credentials): Promise<string> {
    const { refreshState, refreshAttempt, ...settled } = current
    const pending = refreshState === "uncertain"
    if (!pending && Date.parse(current.accessTokenExpiresAt) > now() + 30_000) return current.accessToken
    // A wait longer than the backoff cap can only come from a backward clock jump; treat it as due.
    const wait = refreshAttempt === undefined ? 0 : Date.parse(refreshAttempt.nextAttemptAt) - now()
    if (wait > 0 && wait <= MAX_RETRY_DELAY) throw uncertain()
    // Journal the attempt and its Idempotency-Key before sending. An unknown outcome is only ever
    // resent as this same token, under the journaled key whenever that key meets the 43..128 base64url
    // contract, so a service that committed the rotation (sisyphuslabs/omo-service#628) answers the
    // stored successor instead of a reuse revoke. A journaled key outside the contract (keyless, or an
    // earlier draft's UUID) gets a fresh key: the 1.21.0 service refuses such a key with invalid_request
    // before rotating, so no rotation can have been committed under it.
    // A service without #628 refuses a committed token with reauth_required, which clears the store
    // exactly as the stale grace would have.
    // The next backoff is persisted before every send, so a run killed mid-request cannot resend early.
    const attempts = (refreshAttempt?.attempts ?? 0) + 1
    const backoff = retryDelay(attempts)
    const attempt = {
      idempotencyKey: refreshAttempt !== undefined && IDEMPOTENCY_KEY.test(refreshAttempt.idempotencyKey)
        ? refreshAttempt.idempotencyKey : newIdempotencyKey(),
      attempts,
      nextAttemptAt: new Date(now() + backoff).toISOString(),
    }
    const journal: Credentials = { ...settled, refreshState: "uncertain", refreshAttempt: attempt }
    await store.write(journal)
    try {
      const tokens = parseReply(tokenSchema, await request("/v1/session/refresh", {
        ...jsonRequest({ refreshToken: current.refreshToken }),
        headers: { "content-type": "application/json", "idempotency-key": attempt.idempotencyKey },
      }))
      await store.write({ ...settled, ...tokens })
      return tokens.accessToken
    } catch (error) {
      // Any enveloped answer below 500 other than 429 is definite: it never leaves the record uncertain.
      const definite = error instanceof ApiRefusal && error.status < 500 && error.status !== 429
      if (definite && UNCONSUMED_REFUSALS.has(error.code)) {
        await store.write(settled)
        throw error
      }
      if (definite) {
        await store.clear()
        throw new SessionEnded(error.code === "reauth_required"
          ? "This session was ended because its refresh token was reused. Sign in again with omo login."
          : "Sign in again with omo login.", DEVICE_REVOKING_REFUSALS.has(error.code))
      }
      if (!pending && ((error instanceof RequestFailure && error.notSent) ||
        (error instanceof ApiRefusal && error.status === 429 && error.code === "rate_limited"))) {
        await store.write(current)
        throw error
      }
      if (error instanceof ApiRefusal && error.status === 429) {
        // retryDelay caps Retry-After at 60 s. A wait past the service's 60 s replay grace ends in a
        // reuse revoke by design (#628 threat 9): a late replay must not be distinguishable from theft.
        const delay = Math.max(backoff, error.retryDelay(now(), 0))
        if (delay > backoff) {
          await store.write({ ...journal, refreshAttempt: { ...attempt, nextAttemptAt: new Date(now() + delay).toISOString() } })
        }
      }
      throw uncertain()
    }
  }
  return {
    request,
    signal,
    async ready() { await store.read() },
    async save(value: Credentials) { await locked(() => store.write(value)) },
    async logout(): Promise<boolean> {
      return locked(async () => {
        try {
          const current = await store.read()
          if (current !== null) {
            if (current.refreshState === "uncertain") return false
            const access = Date.parse(current.accessTokenExpiresAt) <= now()
              ? await refreshedAccess(current) : current.accessToken
            await request(`/v1/devices/${encodeURIComponent(current.device.id)}`, {
              method: "DELETE", headers: { authorization: `Bearer ${access}` },
            })
          }
          return true
        } catch (error) {
          if (error instanceof SessionEnded) return error.deviceRevoked
          if (error instanceof SignInError) return false
          throw error
        } finally { await store.clear() }
      })
    },
    async accessToken(): Promise<string> {
      return locked(async () => {
        const current = await store.read()
        if (current === null) throw new SignInError("Not signed in. Run omo login.")
        return refreshedAccess(current)
      })
    },
    async removeForLimit(error: unknown, choose: ChooseDevice): Promise<boolean> {
      if (!(error instanceof ApiRefusal) || error.detail === undefined) throw error
      const headers = { authorization: `Bearer ${error.detail.managementToken}` }
      const listed = parseReply(deviceListSchema, await request("/v1/devices", { headers }))
      const devices = listed.devices.filter(device => device.revokedAt === null)
      const chosen = await choose(devices)
      if (chosen === null) return false
      if (!devices.some(device => device.id === chosen)) throw new SignInError("No matching device was selected.")
      await request(`/v1/devices/${encodeURIComponent(chosen)}`, { method: "DELETE", headers })
      return true
    },
  }
}
export type Session = ReturnType<typeof createSession>
