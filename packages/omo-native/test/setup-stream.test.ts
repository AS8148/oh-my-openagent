import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  SETUP_SOURCES,
  applySetupStages,
  collectSetupPlans,
  scanSetup,
  type SetupStageResult,
} from "../bin/lib/setup-stream.js"

const roots: string[] = []
const SECRET_A = "SK-SENTINEL-STREAM-A"
const SECRET_B = "SK-SENTINEL-STREAM-B"

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

type Fixture = { home: string; agentDir: string; env: Record<string, string> }

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "omo-setup-stream-"))
  roots.push(root)
  const home = join(root, "home")
  write(join(home, ".local", "share", "opencode", "auth.json"), JSON.stringify({
    openai: { type: "api", key: SECRET_A },
    anthropic: { type: "oauth", refresh: "r", access: "a", expires: 1 },
    myco: { type: "api", key: SECRET_B },
  }))
  write(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({
    model: "openai/gpt-5",
    mcp: { ctx: { type: "local", command: ["npx", "ctx"] } },
    provider: { myco: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://example.invalid/v1" }, models: { m1: { name: "M1" } } } },
  }))
  write(join(home, ".config", "opencode", "skills", "my-skill", "SKILL.md"), "---\nname: my-skill\ndescription: d\n---\nbody\n")
  return { home, agentDir: join(home, ".omo", "agent"), env: { HOME: home } }
}

function catalogSpy() {
  const calls: number[] = []
  const loadModelCatalog = async () => {
    calls.push(Date.now())
    return [{ id: "openai", getModels: () => [{ id: "gpt-5" }] }]
  }
  return { calls, loadModelCatalog }
}

async function drain(stream: AsyncIterable<SetupStageResult>): Promise<SetupStageResult[]> {
  const results: SetupStageResult[] = []
  for await (const result of stream) results.push(result)
  return results
}

describe("setup-stream", () => {
  test("#given an OpenCode setup #when the scan streams with custom providers on #then every stage arrives once, in order, with its items", async () => {
    const { home, agentDir, env } = fixture()
    const { loadModelCatalog } = catalogSpy()
    const results = await drain(scanSetup({ home, env, loadModelCatalog }, agentDir, { includeCustomProviders: true }))

    expect(results.map((result) => result.source)).toEqual([...SETUP_SOURCES])
    expect(SETUP_SOURCES).toEqual(["detect", "providers", "credentials", "assets", "model-choices"])
    const items = Object.fromEntries(results.map((result) => [result.source, result.items]))
    expect(items.detect).toContainEqual(expect.objectContaining({ id: "opencode", kind: "harness", state: "found" }))
    expect(items.providers).toContainEqual(expect.objectContaining({ id: "myco", kind: "provider", state: "import" }))
    expect(items.credentials).toContainEqual(expect.objectContaining({ id: "openai", kind: "api-key", state: "import" }))
    expect(items.credentials).toContainEqual(expect.objectContaining({ id: "anthropic", kind: "oauth", state: "login" }))
    expect(items.assets).toContainEqual(expect.objectContaining({ id: "ctx", kind: "mcp", state: "import" }))
    expect(items.assets).toContainEqual(expect.objectContaining({ id: "my-skill", kind: "skill", state: "import" }))
    expect(items["model-choices"]).toContainEqual(expect.objectContaining({ id: "default model", kind: "default", state: "import" }))
    // Items travel over RPC: a key never rides in one.
    const serialized = JSON.stringify(results.map((result) => result.items))
    expect(serialized).not.toContain(SECRET_A)
    expect(serialized).not.toContain(SECRET_B)
  })

  test("#given custom providers off (the default) #when the scan streams #then the provider stage is disabled and its key stays unmapped", async () => {
    const { home, agentDir, env } = fixture()
    const { loadModelCatalog } = catalogSpy()
    const results = await drain(scanSetup({ home, env, loadModelCatalog }, agentDir))

    const providers = results.find((result) => result.source === "providers")
    expect(providers?.disabled).toBe(true)
    expect(providers?.items).toEqual([])
    expect(providers?.plan.pending).toBe(0)
    const credentials = results.find((result) => result.source === "credentials")
    expect(credentials?.items).toContainEqual(expect.objectContaining({ id: "myco", kind: "api-key", state: "unmapped" }))
  })

  test("#given a consumer reading one stage at a time #when it has read four stages #then the model-choice stage has not loaded the model catalog yet", async () => {
    const { home, agentDir, env } = fixture()
    const { calls, loadModelCatalog } = catalogSpy()
    const stream = scanSetup({ home, env, loadModelCatalog }, agentDir, { includeCustomProviders: true })[Symbol.asyncIterator]()
    for (let index = 0; index < 4; index++) expect((await stream.next()).done).toBe(false)
    expect(calls).toHaveLength(0)
    const last = await stream.next()
    expect(last.value?.source).toBe("model-choices")
    expect(calls).toHaveLength(1)
    expect((await stream.next()).done).toBe(true)
  })

  test("#given collected plans #when only the credential stage is accepted #then only auth.json is written", async () => {
    const { home, agentDir, env } = fixture()
    const { loadModelCatalog } = catalogSpy()
    const { inventory, plans } = await collectSetupPlans(scanSetup({ home, env, loadModelCatalog }, agentDir, { includeCustomProviders: true }))
    expect(inventory.harnesses.map((harness) => harness.id)).toContain("opencode")

    const reported: string[] = []
    const applied = await applySetupStages(plans, async (stage) => stage.id === "credentials", (line) => reported.push(line))

    expect([...applied]).toEqual(["credentials"])
    expect(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")).openai).toBeDefined()
    expect(existsSync(join(agentDir, "mcp.json"))).toBe(false)
    expect(existsSync(join(agentDir, "models.json"))).toBe(false)
    expect(existsSync(join(agentDir, "settings.json"))).toBe(false)
  })
})
