/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { customModelProviders } from "./custom-providers"

const dirs: string[] = []

function agentDirWith(modelsJson: string): string {
  const dir = mkdtempSync(join(tmpdir(), "omo-custom-providers-"))
  dirs.push(dir)
  writeFileSync(join(dir, "models.json"), modelsJson)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("customModelProviders", () => {
  it("#given models.json providers with their own models #when read #then lists them in declaration order", () => {
    const dir = agentDirWith(`{
      // JSONC, as senpi parses it
      "providers": {
        "proxy-b": { "baseUrl": "https://b.example/v1", "models": [{ "id": "claude-opus-5-5" }] },
        "anthropic": { "baseUrl": "https://override.example" },
        "proxy-a": { "models": [{ "id": "claude-opus-5-5" }] },
        "empty": { "models": [] },
      },
    }`)

    expect(customModelProviders(dir)).toEqual(["proxy-b", "proxy-a"])
  })

  it("#given no agent dir, no file or malformed providers #when read #then returns no providers", () => {
    expect(customModelProviders(undefined)).toEqual([])
    const withoutFile = mkdtempSync(join(tmpdir(), "omo-custom-providers-missing-"))
    dirs.push(withoutFile)
    expect(customModelProviders(withoutFile)).toEqual([])
    expect(customModelProviders(agentDirWith(`{ "providers": [] }`))).toEqual([])
  })
})
