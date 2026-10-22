import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readAccountInventory } from "./account-inventory"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const NOW = Date.UTC(2026, 9, 22, 15, 0, 0)
const HOUR = 3_600_000
const SECRET = "sk-ant-oat01-synthetic-never-ships"

function agentDir(files: { readonly auth?: unknown; readonly pool?: unknown }): string {
  const dir = mkdtempSync(join(tmpdir(), "omo-accounts-"))
  dirs.push(dir)
  if (files.auth !== undefined)
    writeFileSync(
      join(dir, "auth.json"),
      typeof files.auth === "string" ? files.auth : JSON.stringify(files.auth),
    )
  if (files.pool !== undefined)
    writeFileSync(
      join(dir, "credential-pool-state.json"),
      typeof files.pool === "string" ? files.pool : JSON.stringify(files.pool),
    )
  return dir
}

const slot = (o: Record<string, unknown> = {}) => ({ stateVersion: 1, ...o })
const pool = (providers: Record<string, Record<string, Record<string, unknown>>>) => ({
  schemaVersion: 1,
  installationKey: "synthetic",
  providers: Object.fromEntries(
    Object.entries(providers).map(([p, lanes]) => [
      p,
      { lanes: Object.fromEntries(Object.entries(lanes).map(([l, slots]) => [l, { slots }])) },
    ]),
  ),
})

describe("readAccountInventory (#10919: accounts per provider, counts only)", () => {
  it("#given several accounts per provider in auth.json #then connected counts per kind, and no account name, email or token ships", () => {
    const inventory = readAccountInventory(
      agentDir({
        auth: {
          "chatgpt-subscription": {
            accounts: [
              { name: "me@example.com", access: SECRET },
              { name: "two@example.com", access: SECRET },
              { name: "three", access: SECRET },
            ],
          },
          "anthropic-subscription": {
            accounts: [
              { name: "work", access: SECRET },
              { name: "home", access: SECRET },
            ],
          },
          openai: { type: "api", key: SECRET },
        },
      }),
      NOW,
    )
    expect(inventory.connected).toBe("anthropic-subscription:2,chatgpt-subscription:3,openai:1")
    for (const leak of ["example.com", "work", "home", "sk-ant"])
      expect(JSON.stringify(inventory)).not.toContain(leak)
  })

  it("#given pool slots with a live lease or a success in the last 5 hours #then those count as concurrently active, distinct across lanes", () => {
    const inventory = readAccountInventory(
      agentDir({
        auth: { "chatgpt-subscription": { accounts: [{}, {}, {}] } },
        pool: pool({
          "chatgpt-subscription": {
            default: {
              a: slot({ lastSuccessAt: NOW - HOUR }),
              b: slot({ lease: { id: "x", expiresAt: NOW + 60_000 } }),
              c: slot({ lastSuccessAt: NOW - 6 * HOUR }),
            },
            "gpt-6": { a: slot({ lastSuccessAt: NOW - 2 * HOUR }) },
          },
        }),
      }),
      NOW,
    )
    expect(inventory.connected).toBe("chatgpt-subscription:3")
    expect(inventory.active).toBe("chatgpt-subscription:2")
  })

  it("#given an expired lease and an old success #then the slot is not active", () => {
    const inventory = readAccountInventory(
      agentDir({
        auth: { "anthropic-subscription": { accounts: [{}] } },
        pool: pool({
          "anthropic-subscription": {
            default: {
              a: slot({
                lease: { id: "x", expiresAt: NOW - 1 },
                lastSuccessAt: NOW - 5 * HOUR - 1,
              }),
            },
          },
        }),
      }),
      NOW,
    )
    expect(inventory.active).toBe("")
  })

  it("#given retired, unknown and many-account providers #then current names, unknown summed into custom, and counts capped at 10_plus", () => {
    const inventory = readAccountInventory(
      agentDir({
        auth: {
          "claude-sdk-oauth": { accounts: [{}, {}] },
          "acme-gateway": { accounts: [{}, {}] },
          "private-cloud": { key: SECRET },
          "chatgpt-subscription": { accounts: Array.from({ length: 14 }, () => ({})) },
        },
      }),
      NOW,
    )
    expect(inventory.connected).toBe(
      "anthropic-subscription:2,chatgpt-subscription:10_plus,custom:3",
    )
    expect(JSON.stringify(inventory)).not.toContain("acme")
  })

  it("#given no auth.json and no pool #then both are empty without a diagnostic; a malformed file reports one fixed diagnostic", () => {
    const diagnostics: unknown[] = []
    expect(readAccountInventory(agentDir({}), NOW, (d) => diagnostics.push(d))).toEqual({
      connected: "",
      active: "",
    })
    expect(diagnostics).toEqual([])
    readAccountInventory(
      agentDir({ auth: `{"anthropic": ${SECRET}}`, pool: "{not json" }),
      NOW,
      (d) => diagnostics.push(d),
    )
    expect(diagnostics).toHaveLength(2)
    expect(
      JSON.stringify(
        diagnostics.map((d) =>
          String(Reflect.get(Object(Reflect.get(Object(d), "error")), "message")),
        ),
      ),
    ).not.toContain("sk")
  })
})
