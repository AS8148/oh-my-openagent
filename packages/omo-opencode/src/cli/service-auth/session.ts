import { randomUUID } from "node:crypto"
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
const ENDING_REFUSALS = new Set(["unauthorized", "invalid_grant", ...DEVICE_REVOKING_REFUSALS])
const retryDelay = (attempts: number) => Math.min(300_000, 5_000 * 2 ** (attempts - 1))

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
    if (refreshAttempt !== undefined && Date.parse(refreshAttempt.nextAttemptAt) > now()) throw uncertain()
    // Journal the attempt and its Idempotency-Key before sending. An unknown outcome is only ever
    // resent as this same token with this same key, so a service that committed the rotation
    // (sisyphuslabs/omo-service#628) answers the stored successor instead of a reuse revoke.
    // A service without #628 refuses a committed token with reauth_required, which clears the store
    // exactly as the stale grace would have; a keyless journal from an older CLI is adopted the same way.
    const attempt = refreshAttempt ?? { idempotencyKey: randomUUID(), attempts: 0, nextAttemptAt: new Date(now()).toISOString() }
    const journal: Credentials = { ...settled, refreshState: "uncertain", refreshAttempt: attempt }
    if (refreshAttempt === undefined) await store.write(journal)
    try {
      const tokens = parseReply(tokenSchema, await request("/v1/session/refresh", {
        ...jsonRequest({ refreshToken: current.refreshToken }),
        headers: { "content-type": "application/json", "idempotency-key": attempt.idempotencyKey },
      }))
      await store.write({ ...settled, ...tokens })
      return tokens.accessToken
    } catch (error) {
      if (error instanceof ApiRefusal && error.status < 500 && ENDING_REFUSALS.has(error.code)) {
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
      const attempts = attempt.attempts + 1
      await store.write({ ...journal, refreshAttempt: {
        ...attempt, attempts, nextAttemptAt: new Date(now() + retryDelay(attempts)).toISOString(),
      } })
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
            const access = Date.parse(current.accessTokenExpiresAt) <= Date.now()
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
