import { createHash } from "node:crypto"
import { credentialSchema, type Credentials, serviceOrigin, SignInError } from "./protocol"
import { probeSecretServiceLock, type SecretServiceLockProbe } from "./secret-service-lock"

type SecretKey = { readonly service: string; readonly name: string }
export type SecretApi = {
  readonly get: (key: SecretKey) => Promise<string | null>
  readonly set: (key: SecretKey & { readonly value: string }) => Promise<void>
  readonly delete: (key: SecretKey) => Promise<boolean>
}
export type CredentialStore = {
  readonly read: () => Promise<Credentials | null>
  readonly write: (value: Credentials) => Promise<void>
  readonly clear: () => Promise<void>
}

export class KeychainLockedError extends SignInError {}
export class SecretServiceUnavailableError extends SignInError {}

// The OS store refused because it is locked and may not ask the person (macOS errSecInteractionNotAllowed,
// a locked libsecret keyring). Callers must surface this as its own outcome, never as a prompt.
const LOCKED = /-25308|errSecInteractionNotAllowed|interaction is not allowed|\bis locked\b|locked collection/i
const isLocked = (error: unknown): boolean =>
  error instanceof Error && (LOCKED.test(error.message) || LOCKED.test(String((error as { code?: unknown }).code ?? "")))

export function credentialId(api: string): string {
  return createHash("sha256").update(serviceOrigin(api)).digest("hex")
}

export function createCredentialStore(
  api: string,
  secrets: SecretApi | null = typeof Bun === "undefined" ? null : Bun.secrets,
  platform: NodeJS.Platform = process.platform,
  lockProbe: SecretServiceLockProbe = probeSecretServiceLock,
): CredentialStore {
  if (!secrets) throw new SignInError("OmO sign-in needs Bun 1.4 or newer with OS credential storage. No file fallback is available.")
  const platformName = platform === "darwin" ? "macOS Keychain"
    : platform === "linux" ? "Linux Secret Service (libsecret and an unlocked keyring)"
    : platform === "win32" ? "Windows Credential Manager" : null
  if (platformName === null) throw new SignInError("This platform has no supported OS credential store.")
  const key = { service: "omo-cli", name: credentialId(api) }
  const unavailable = (error: unknown) => isLocked(error)
    ? new KeychainLockedError(`${platformName} is locked. Unlock it, then try again. Credentials are never saved to a file.`)
    : new SignInError(`Cannot access ${platformName}. Unlock or enable the OS credential store and try again. Credentials are never saved to a file.`)
  // libsecret answers a locked collection by asking the keyring to show its unlock prompt, so on Linux the
  // Locked property is read over D-Bus BEFORE any secret call; a locked or missing store is never touched.
  const assertUsable = async () => {
    if (platform !== "linux") return
    const lock = await lockProbe()
    if (lock === "locked") throw new KeychainLockedError(`${platformName} is locked. Unlock it, then try again. Credentials are never saved to a file.`)
    if (lock === "absent") throw new SecretServiceUnavailableError(`No ${platformName} is running. Start a keyring (for example gnome-keyring) and try again. Credentials are never saved to a file.`)
  }
  return {
    async read() {
      await assertUsable()
      let value: string | null
      try { value = await secrets.get(key) } catch (error) { throw unavailable(error) }
      if (value === null) return null
      try { return credentialSchema.parse(JSON.parse(value)) } catch {
        throw new SignInError("Stored sign-in data is invalid. Run omo logout, then omo login.")
      }
    },
    async write(value) {
      // One OS-store replacement commits the rotating token and its access token together.
      await assertUsable()
      try { await secrets.set({ ...key, value: JSON.stringify(credentialSchema.parse(value)) }) } catch (error) { throw unavailable(error) }
    },
    async clear() {
      await assertUsable()
      try { await secrets.delete(key) } catch (error) { throw unavailable(error) }
    },
  }
}
