// The signed-in device as memory sync sees it: the service origin, the account its sync records
// are bound to, the key pair it registered at sign-in, and a bearer token that refreshes. A host
// supplies one DeviceAccountSource; everything after it is the same code for the TUI, the CLI and
// the desktop. Private keys stay in the credential store and reach only the keyring built from them.

import {
  type Credentials,
  createCredentialStore,
  type CredentialStore,
  createSession,
  KeychainApprovalPendingError,
  quietNotice,
  serviceOrigin,
  SignInError,
} from "@oh-my-opencode/omo-opencode/service-auth"
import { randomUUID } from "node:crypto"
import { deviceKeyringFromMaterial } from "@oh-my-opencode/memory-core/sync-engine"
import { cliAccountOperation, scopedCliKeyring } from "./cli-account-operation"

import type { DeviceKeyMaterial, DeviceKeyring } from "@oh-my-opencode/memory-core/keyring"
import type { DesktopSyncDescriptor, SyncOperationAuthority, DesktopSyncOperation, DesktopSyncAccount } from "@oh-my-opencode/memory-core/sync-engine"

import { SyncConfigError } from "../sync-config-error"
import { SyncSessionDeferredError } from "../sync-session-deferred"

export type KeyringFactory = (material: DeviceKeyMaterial) => Promise<DeviceKeyring>

export interface CliDeviceAccount {
  readonly kind: "cli"
  readonly descriptor: DesktopSyncDescriptor
  readonly signal: AbortSignal
  boundary<T>(dispatch: () => T): Promise<T>
  forOperation(authority: SyncOperationAuthority): Promise<DesktopSyncOperation>
  readonly api: string
  readonly accountId: string
  readonly serviceDeviceId: string
  readonly keyring: (build: KeyringFactory) => Promise<DeviceKeyring>
  readonly accessToken: () => Promise<string>
  /** True once the device's credentials are gone (signed out, or the service revoked the device). */
  readonly signedOut: () => Promise<boolean>
  readonly isCurrent: () => Promise<boolean>
}

export type { DesktopSyncDescriptor, SyncDevice, SyncOperationAuthority, DesktopSyncOperation, DesktopSyncAccount } from "@oh-my-opencode/memory-core/sync-engine"

export type DeviceAccount = CliDeviceAccount | DesktopSyncAccount
export type DeviceAccountSource = () => Promise<DeviceAccount | null>

export const DEFAULT_SERVICE_API = "https://api.omo.dev"

const base64url = (base64: string): string => Buffer.from(base64, "base64").toString("base64url")

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

async function accountIdOf(api: string, token: string, doFetch: typeof fetch): Promise<string> {
  const response = await doFetch(`${api}/v1/me`, { headers: { authorization: `Bearer ${token}` } })
  if (!response.ok) throw new Error(`memory sync: the account read failed (${response.status})`)
  const body: unknown = await response.json()
  const account = isRecord(body) ? body["account"] : undefined
  const id = isRecord(account) ? account["id"] : undefined
  if (typeof id !== "string" || id === "") throw new Error("memory sync: the account read named no account")
  return id
}

export function createCliAccountSource(options: {
  readonly api?: string
  readonly env?: Record<string, string | undefined>
  readonly store?: CredentialStore
  readonly fetch?: typeof fetch
}): () => Promise<CliDeviceAccount | null> {
  const configured = options.api === undefined ? options.env?.OMO_SERVICE_API_URL : undefined
  let api: string
  try {
    api = serviceOrigin(options.api ?? configured ?? DEFAULT_SERVICE_API)
  } catch (error) {
    if (configured !== undefined) throw new SyncConfigError("OMO_SERVICE_API_URL", error)
    throw error
  }
  const doFetch = options.fetch ?? fetch
  let active: { readonly generation: string; readonly abort: AbortController } | undefined
  // A keychain waiting for its approval dialog is not a signed-out device: sync defers this pass and retries.
  return async () => {
    try {
      return await resolve()
    } catch (error) {
      if (error instanceof KeychainApprovalPendingError) throw new SyncSessionDeferredError(error.message, error)
      throw error
    }
  }
  async function resolve(): Promise<CliDeviceAccount | null> {
    let store: CredentialStore
    let credentials: Credentials | null
    try {
      // A host runs under a TUI: the CLI's keyring-fallback notice must not write over it, and the fallback is
      // the same libsecret path the CLI uses (#10658 review).
      store = options.store ?? createCredentialStore(api, { notice: quietNotice })
      credentials = await store.read()
    } catch (error) {
      if (error instanceof KeychainApprovalPendingError) throw error
      // A host with no usable OS credential store (plain Node, a locked or absent keyring) cannot be
      // signed in; that is the signed-out state, not a sync failure on every session bind.
      if (error instanceof SignInError) return null
      throw error
    }
    if (credentials === null) { active?.abort.abort(); active = undefined; return null }
    const session = createSession({ api, store })
    const initial = credentials
    const matches = (current: Credentials): boolean => current.device.id === initial.device.id
      && current.signingPrivateKey === initial.signingPrivateKey && current.sealingPrivateKey === initial.sealingPrivateKey
      && (initial.credentialGeneration === undefined || current.credentialGeneration === initial.credentialGeneration)
    const accountId = await accountIdOf(api, await session.accessToken(), doFetch)
    credentials = await session.update(async current => {
      if (current === null || !matches(current)) return null
      if (current.credentialGeneration === undefined || current.accountId !== accountId) {
        await store.write({ ...current, accountId, credentialGeneration: current.credentialGeneration ?? randomUUID() })
        return store.read()
      }
      return current
    })
    if (credentials === null || credentials.credentialGeneration === undefined || credentials.accountId !== accountId) return null
    const captured = credentials
    const generation = credentials.credentialGeneration
    if (active?.generation !== generation) {
      active?.abort.abort()
      active = { generation, abort: new AbortController() }
    }
    const abort = active.abort
    const sameCaptured = (current: Credentials | null): boolean => current !== null && current.accountId === accountId
      && current.credentialGeneration === generation && current.device.id === captured.device.id
      && current.signingPrivateKey === captured.signingPrivateKey && current.sealingPrivateKey === captured.sealingPrivateKey
    const isCurrent = async (): Promise<boolean> => {
      if (abort.signal.aborted) return false
      const current = await store.read()
      const same = sameCaptured(current)
      if (!same) abort.abort()
      return same && !abort.signal.aborted
    }
    const boundary = async <T>(dispatch: () => T): Promise<T> => {
      const result = await session.update(current => {
        if (abort.signal.aborted || !sameCaptured(current)) {
          abort.abort()
          throw new Error("The CLI sync account is no longer current.")
        }
        // Box the return value: release the lock after dispatch itself, not an in-flight request.
        return Promise.resolve({ value: dispatch() })
      })
      return result.value
    }
    const check = async () => { if (!await isCurrent()) throw new Error("The CLI sync account is no longer current.") }
    const accessToken = async () => { await check(); const token = await session.accessToken(); await check(); return token }
    const material = { signingPrivatePkcs8: base64url(captured.signingPrivateKey), sealingPrivatePkcs8: base64url(captured.sealingPrivateKey) }
    const raw = await deviceKeyringFromMaterial(material)
    await check()
    const descriptor: DesktopSyncDescriptor = {
      genesis: "unsupported", rpId: null, userName: null,
      serviceOrigin: api, accountId, serviceDeviceId: captured.device.id,
      syncPrincipalId: raw.principal().id, publicKeys: raw.publicKeys(), generation,
    }
    const authority: SyncOperationAuthority = {
      signal: abort.signal,
      admit: effect => { abort.signal.throwIfAborted(); return effect() },
    }
    return {
      kind: "cli",
      descriptor,
      signal: abort.signal,
      boundary,
      forOperation: owner => cliAccountOperation({ descriptor, lifetime: abort.signal, isCurrent, boundary, accessToken, keyring: raw, fetch: doFetch }, owner),
      api,
      accountId,
      serviceDeviceId: captured.device.id,
      keyring: async build => { await check(); const keyring = await build(material); await check(); return scopedCliKeyring(keyring, check, authority, boundary) },
      accessToken,
      isCurrent,
      signedOut: async () => {
        try {
          return (await store.read()) === null
        } catch (error) {
          if (error instanceof KeychainApprovalPendingError) return false
          throw error
        }
      },
    }
  }
}
