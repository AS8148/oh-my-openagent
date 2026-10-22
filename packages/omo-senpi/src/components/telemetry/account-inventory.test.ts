import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readConnectedAccounts } from "./account-inventory"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const SECRET = "sk-ant-oat01-synthetic-never-ships"

function agentDir(auth?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "omo-accounts-"))
  dirs.push(dir)
  if (auth !== undefined) writeFileSync(join(dir, "auth.json"), typeof auth === "string" ? auth : JSON.stringify(auth))
  return dir
}

describe("readConnectedAccounts (#10919: linked accounts per provider, counts only)", () => {
  it("#given several linked accounts per provider #then counts per kind, used or not, and no account name, email or token ships", () => {
    const connected = readConnectedAccounts(agentDir({
      "chatgpt-subscription": { accounts: [{ name: "me@example.com", access: SECRET }, { name: "two@example.com", access: SECRET }, { name: "three", access: SECRET }] },
      "anthropic-subscription": { accounts: [{ name: "work", access: SECRET }, { name: "home", access: SECRET }] },
      openai: { type: "api", key: SECRET },
    }))
    expect(connected).toBe("anthropic-subscription:2,chatgpt-subscription:3,openai:1")
    for (const leak of ["example.com", "work", "home", "sk-ant"]) expect(connected).not.toContain(leak)
  })

  it("#given retired, unknown and many-account providers #then current names, unknown summed into custom, and counts capped at 10_plus", () => {
    const connected = readConnectedAccounts(agentDir({
      "claude-sdk-oauth": { accounts: [{}, {}] },
      "acme-gateway": { accounts: [{}, {}] },
      "private-cloud": { key: SECRET },
      "chatgpt-subscription": { accounts: Array.from({ length: 14 }, () => ({})) },
    }))
    expect(connected).toBe("anthropic-subscription:2,chatgpt-subscription:10_plus,custom:3")
    expect(connected).not.toContain("acme")
  })

  it("#given no auth.json or a malformed one #then empty (the provider inventory already reports the malformed file once)", () => {
    expect(readConnectedAccounts(agentDir())).toBe("")
    expect(readConnectedAccounts(agentDir(`{"anthropic": ${SECRET}}`))).toBe("")
  })

  it("#given an emptied account list #then that provider is not counted; a single credential without a list still counts 1 (#10922 review)", () => {
    expect(readConnectedAccounts(agentDir({ openai: { accounts: [] }, anthropic: { type: "api", key: SECRET }, xai: null }))).toBe("anthropic:1,xai:1")
  })
})
