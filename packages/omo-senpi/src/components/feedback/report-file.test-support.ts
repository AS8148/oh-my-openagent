import { expect } from "bun:test"
import { spawnSync } from "node:child_process"
import { statSync } from "node:fs"
import { isAbsolute, relative } from "node:path"

const WINDOWS_SYSTEM_SID = "S-1-5-18"
const WINDOWS_ADMINISTRATORS_SID = "S-1-5-32-544"

export interface WindowsAclEntry {
  readonly sid: string
  readonly type: "Allow" | "Deny"
}

/** The file's ACL as SIDs, read through Get-Acl so the check does not depend on localized account names. */
export const readWindowsAcl = (path: string): { readonly user: string; readonly entries: readonly WindowsAclEntry[] } => {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$acl = Get-Acl -LiteralPath $env:OMO_ACL_PATH",
    "$entries = @($acl.Access | ForEach-Object { @{ sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; type = [string]$_.AccessControlType } })",
    "@{ user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; entries = $entries } | ConvertTo-Json -Compress -Depth 3",
  ].join("; ")
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: { ...process.env, OMO_ACL_PATH: path },
  })
  if (result.status !== 0) throw new Error(`Get-Acl failed for ${path}: ${result.stderr}`)
  const parsed = JSON.parse(result.stdout) as { user: string; entries: WindowsAclEntry[] | WindowsAclEntry | null }
  const entries = parsed.entries === null ? [] : Array.isArray(parsed.entries) ? parsed.entries : [parsed.entries]
  return { user: parsed.user, entries }
}

export const unexpectedWindowsReaders = (acl: ReturnType<typeof readWindowsAcl>): readonly string[] => {
  const allowed = new Set([acl.user, WINDOWS_SYSTEM_SID, WINDOWS_ADMINISTRATORS_SID])
  return acl.entries.filter((entry) => entry.type === "Allow" && !allowed.has(entry.sid)).map((entry) => entry.sid)
}

/**
 * A saved report or ledger must be readable by its owner only. Every platform: it lives inside the per-user state root.
 * POSIX: owner-only mode bits. Windows (no mode bits): its ACL grants access only to the current user, SYSTEM and the
 * Administrators group, read as SIDs.
 */
export const expectUserOnly = (path: string, root: string): void => {
  const inside = relative(root, path)
  expect(inside === "" || inside.startsWith("..") || isAbsolute(inside)).toBe(false)
  if (process.platform === "win32") {
    const acl = readWindowsAcl(path)
    expect(acl.entries.some((entry) => entry.type === "Allow" && entry.sid === acl.user)).toBe(true)
    expect(unexpectedWindowsReaders(acl)).toEqual([])
    return
  }
  expect(statSync(path).mode & 0o077).toBe(0)
}
