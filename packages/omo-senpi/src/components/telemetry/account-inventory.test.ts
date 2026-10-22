import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { connectedAccountCounts, readConnectedAccounts } from "./account-inventory"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const SECRET = "sk-ant-oat01-synthetic-never-ships"
const NO_ENV: Readonly<Record<string, string | undefined>> = {}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omo-accounts-"))
  dirs.push(dir)
  return dir
}

function agentDir(auth?: unknown): string {
  const dir = tempDir()
  if (auth !== undefined) writeFileSync(join(dir, "auth.json"), typeof auth === "string" ? auth : JSON.stringify(auth))
  return dir
}

const login = (name: string) => ({ name, access: SECRET, refresh: SECRET, expires: 1 })
const SENTINEL = { type: "oauth", access: "claude-subscription-managed", refresh: "claude-subscription-managed", expires: 4102444800000 }

describe("readConnectedAccounts (#10919: linked accounts per provider, as the engine lists them)", () => {
  it("#given 3 linked Claude accounts and 3 ChatGPT accounts #then each kind counts 3, and no account name, email or token ships", () => {
    const connected = readConnectedAccounts(agentDir({
      "anthropic-subscription": { ...SENTINEL, accounts: [login("me@example.com"), login("work"), login("home")] },
      "chatgpt-subscription": { type: "oauth", access: SECRET, refresh: SECRET, expires: 1, accounts: [login("a"), login("b"), login("c")] },
    }), NO_ENV)
    expect(connected).toBe("anthropic-subscription:3,chatgpt-subscription:3")
    for (const leak of ["example.com", "work", "home", "sk-ant"]) expect(connected).not.toContain(leak)
  })

  it("#given the managed Claude sentinel without an account list #then Claude counts 0 and is not listed", () => {
    expect(readConnectedAccounts(agentDir({ "anthropic-subscription": SENTINEL }), NO_ENV)).toBe("")
  })

  it("#given Claude env-var accounts #then each discovered env slot is counted beside the stored ones", () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: SECRET, CLAUDE_CODE_OAUTH_TOKEN_3: SECRET }
    expect(readConnectedAccounts(agentDir({ "anthropic-subscription": { ...SENTINEL, accounts: [login("a")] } }), env)).toBe("anthropic-subscription:3")
  })

  it("#given a non-Claude provider with an empty account list #then the engine's flat credential counts 1; an env key counts only when nothing is stored", () => {
    expect(readConnectedAccounts(agentDir({ openai: { type: "api_key", key: SECRET, accounts: [] } }), { OPENAI_API_KEY: SECRET })).toBe("openai:1")
    expect(readConnectedAccounts(agentDir({}), { OPENAI_API_KEY: SECRET, OPENAI_API_KEY_2: SECRET })).toBe("openai:2")
  })

  it("#given retired, unknown and many-account providers #then current names, unknown summed into custom, and counts capped at 10_plus", () => {
    const connected = readConnectedAccounts(agentDir({
      "claude-sdk-oauth": { ...SENTINEL, accounts: [login("a"), login("b")] },
      "acme-gateway": { type: "api_key", key: SECRET, accounts: [login("a"), login("b")] },
      "private-cloud": { type: "api_key", key: SECRET },
      "chatgpt-subscription": { type: "oauth", access: SECRET, refresh: SECRET, expires: 1, accounts: Array.from({ length: 14 }, (_, i) => login(`s${i}`)) },
    }), NO_ENV)
    expect(connected).toBe("anthropic-subscription:2,chatgpt-subscription:10_plus,custom:3")
    expect(connected).not.toContain("acme")
  })

  it("#given no auth.json or a malformed one #then only env slots count (the provider inventory already reports the malformed file once)", () => {
    expect(readConnectedAccounts(agentDir(), NO_ENV)).toBe("")
    expect(readConnectedAccounts(agentDir(`{"anthropic": ${SECRET}}`), NO_ENV)).toBe("")
  })
})

type EngineAccounts = {
  getCredentialAccounts(storage: unknown, provider: string, env: Readonly<Record<string, string | undefined>>, repository: unknown): Promise<readonly unknown[]>
}
type EngineStore = { CredentialSlotRepository: new (path: string) => unknown }
type EngineAuth = { AuthStorage: { inMemory(data?: Record<string, unknown>): unknown } }

const senpiDist = dirname(fileURLToPath(import.meta.resolve("@code-yeongyu/senpi")))
const engineImport = async <T,>(...path: string[]): Promise<T> => (await import(pathToFileURL(join(senpiDist, ...path)).href)) as T

describe("parity with the engine's own account listing (senpi getCredentialAccounts)", () => {
  const FIXTURES: readonly (readonly [string, Record<string, unknown>, Readonly<Record<string, string | undefined>>])[] = [
    ["3 Claude logins", { "anthropic-subscription": { ...SENTINEL, accounts: [login("a"), login("b"), login("c")] } }, NO_ENV],
    ["managed sentinel", { "anthropic-subscription": SENTINEL }, NO_ENV],
    ["Claude env slots beside a login", { "anthropic-subscription": { ...SENTINEL, accounts: [login("a")] } }, { CLAUDE_CODE_OAUTH_TOKEN: SECRET, CLAUDE_CODE_OAUTH_TOKEN_5: SECRET }],
    ["Claude env slots only", {}, { CLAUDE_CODE_OAUTH_TOKEN: SECRET, CLAUDE_CODE_OAUTH_TOKEN_2: SECRET }],
    ["non-Claude empty list", { openai: { type: "api_key", key: SECRET, accounts: [] } }, { OPENAI_API_KEY: SECRET }],
    ["non-Claude flat key", { openai: { type: "api_key", key: SECRET } }, NO_ENV],
    ["non-Claude pool", { "chatgpt-subscription": { type: "oauth", access: SECRET, refresh: SECRET, expires: 1, accounts: [login("a"), login("b")] } }, NO_ENV],
    ["env-only API keys", {}, { OPENAI_API_KEY: SECRET, OPENAI_API_KEY_2: SECRET, ANTHROPIC_API_KEY: SECRET }],
  ]

  for (const [label, auth, env] of FIXTURES) {
    it(`#given ${label} #then our count per provider equals the engine's listing length`, async () => {
      const { getCredentialAccounts } = await engineImport<EngineAccounts>("core", "credential-accounts.js")
      const { CredentialSlotRepository } = await engineImport<EngineStore>("core", "credential-pool", "state-store.js")
      const { AuthStorage } = await engineImport<EngineAuth>("core", "auth-storage.js")
      const storage = AuthStorage.inMemory(structuredClone(auth))
      const repository = new CredentialSlotRepository(join(tempDir(), "credential-pool-state.json"))
      const ours = connectedAccountCounts(structuredClone(auth), env)
      for (const [provider, count] of ours) {
        expect([provider, (await getCredentialAccounts(storage, provider, env, repository)).length]).toEqual([provider, count])
      }
      for (const provider of new Set([...Object.keys(auth), "anthropic-subscription", "openai", "anthropic"])) {
        const engine = (await getCredentialAccounts(storage, provider, env, repository)).length
        expect([provider, ours.get(provider) ?? 0]).toEqual([provider, engine])
      }
    })
  }
})
