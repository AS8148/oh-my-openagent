import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readOmoNativeInventory } from "./session-inventory"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function agentDir(files: { readonly models?: unknown; readonly auth?: string | unknown; readonly settings?: unknown }): string {
  const dir = mkdtempSync(join(tmpdir(), "omo-inventory-"))
  dirs.push(dir)
  writeFileSync(join(dir, "models.json"), JSON.stringify(files.models ?? { providers: {} }))
  writeFileSync(join(dir, "settings.json"), JSON.stringify(files.settings ?? {}))
  if (files.auth !== undefined) {
    writeFileSync(join(dir, "auth.json"), typeof files.auth === "string" ? files.auth : JSON.stringify(files.auth))
  }
  return dir
}

const SECRET = "sk-ant-oat01-synthetic-never-ships"

describe("readOmoNativeInventory: providers the user can use (#10887)", () => {
  it("#given only signed-in providers in auth.json #then they are counted by kind, and no credential value leaves", () => {
    const inventory = readOmoNativeInventory(agentDir({
      auth: { "anthropic-subscription": { type: "oauth", access: SECRET }, openai: { type: "api", key: SECRET } },
    }))
    expect(inventory).toMatchObject({
      providerCount: 2,
      signedInProviderCount: 2,
      configuredProviderCount: 0,
      providers: "anthropic-subscription,openai",
    })
    expect(JSON.stringify(inventory)).not.toContain(SECRET)
  })

  it("#given a provider both signed in and configured #then it counts once in the union", () => {
    const inventory = readOmoNativeInventory(agentDir({
      models: { providers: { anthropic: { models: [{ id: "claude-sonnet-5" }] } } },
      auth: { anthropic: { type: "api", key: SECRET } },
    }))
    expect(inventory).toMatchObject({ providerCount: 1, signedInProviderCount: 1, configuredProviderCount: 1, providers: "anthropic" })
  })

  it("#given retired subscription names #then they are reported under the current kind", () => {
    const inventory = readOmoNativeInventory(agentDir({ auth: { "claude-sdk-oauth": {}, "openai-codex": {} } }))
    expect(inventory.providers).toBe("anthropic-subscription,chatgpt-subscription")
    expect(inventory.providerCount).toBe(2)
  })

  it("#given an unknown provider name #then it ships only as custom, never by name", () => {
    const inventory = readOmoNativeInventory(agentDir({
      models: { providers: { "acme-internal-gateway": { models: [] } } },
      auth: { "private-cloud": {} },
    }))
    expect(inventory).toMatchObject({ providerCount: 2, providers: "custom" })
    expect(JSON.stringify(inventory)).not.toContain("acme")
    expect(JSON.stringify(inventory)).not.toContain("private-cloud")
  })

  it("#given no auth.json #then only configured providers count, without a diagnostic", () => {
    const diagnostics: unknown[] = []
    const inventory = readOmoNativeInventory(agentDir({ models: { providers: { openai: {} } } }), (d) => diagnostics.push(d))
    expect(inventory).toMatchObject({ providerCount: 1, signedInProviderCount: 0, configuredProviderCount: 1, providers: "openai" })
    expect(diagnostics).toEqual([])
  })

  it("#given a malformed auth.json #then configured providers still count and one diagnostic is reported", () => {
    const diagnostics: unknown[] = []
    const inventory = readOmoNativeInventory(agentDir({ models: { providers: { openai: {} } }, auth: "{not json" }), (d) => diagnostics.push(d))
    expect(inventory).toMatchObject({ providerCount: 1, signedInProviderCount: 0, configuredProviderCount: 1, providers: "openai" })
    expect(diagnostics).toHaveLength(1)
  })
})
