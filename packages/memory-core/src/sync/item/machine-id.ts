// Machine identity for the device peer (review r4 MEDIUM): the peer file stores a hash of the
// OS machine id, so a state dir copied to another machine (migration, restored backup, cloned
// VM) is detected there and a new peer is minted instead of sharing (peer, counter) ranges.
// Sources: /etc/machine-id (Linux), IOPlatformUUID (macOS), MachineGuid (Windows); the
// hostname is the last resort when the platform source is unavailable.

import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { hostname } from "node:os"

import { readFile } from "../../fs/resilient"

export function machineFingerprint(machineId: string): string {
  return createHash("sha256").update(`omo-item-device:${machineId}`).digest("hex")
}

let cached: Promise<string> | null = null

export function readMachineId(): Promise<string> {
  cached ??= platformMachineId().then((id) => id ?? `hostname:${hostname()}`)
  return cached
}

async function platformMachineId(): Promise<string | null> {
  if (process.platform === "linux") {
    for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      const text = await readFile(path, "utf8").then(
        (value) => value.trim(),
        () => "",
      )
      if (text !== "") return text
    }
    return null
  }
  if (process.platform === "darwin") {
    const out = await run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"])
    return /"IOPlatformUUID" = "([^"]+)"/.exec(out ?? "")?.[1] ?? null
  }
  if (process.platform === "win32") {
    const out = await run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"])
    return /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out ?? "")?.[1] ?? null
  }
  return null
}

function run(command: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, [...args], { timeout: 5_000, windowsHide: true }, (error, stdout) => {
      resolve(error === null ? stdout : null)
    })
  })
}
