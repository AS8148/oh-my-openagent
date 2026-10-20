import { spawn } from "node:child_process"

export type SecretServiceLockState = "locked" | "unlocked" | "absent"
export type SecretServiceLockProbe = () => Promise<SecretServiceLockState>

const DEFAULT_COLLECTION = "/org/freedesktop/secrets/aliases/default"
const PROBE_TIMEOUT_MS = 3000

// Bun.secrets.get answers null for a LOCKED libsecret collection, exactly as for a missing item, so on
// Linux a null read is only "signed out" once the default collection reports Locked=false over the same
// session bus. No reachable Secret Service is its own answer, never a sign-out.
export const parseLockedReply = (stdout: string): SecretServiceLockState | null => {
  const match = /<\s*(true|false)\s*>/.exec(stdout)
  if (match === null) return null
  return match[1] === "true" ? "locked" : "unlocked"
}

export const probeSecretServiceLock: SecretServiceLockProbe = () =>
  new Promise((resolve) => {
    const child = spawn("gdbus", [
      "call", "--session",
      "--dest", "org.freedesktop.secrets",
      "--object-path", DEFAULT_COLLECTION,
      "--method", "org.freedesktop.DBus.Properties.Get",
      "org.freedesktop.Secret.Collection", "Locked",
    ], { stdio: ["ignore", "pipe", "ignore"] })
    let stdout = ""
    const timer = setTimeout(() => { child.kill(); resolve("absent") }, PROBE_TIMEOUT_MS)
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString() })
    child.on("error", () => { clearTimeout(timer); resolve("absent") })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? (parseLockedReply(stdout) ?? "absent") : "absent")
    })
  })
