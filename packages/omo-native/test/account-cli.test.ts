import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { creatorAnchor } from "../../memory-core/src/sync/crypto/anchor.ts"
import { appendEntries, emptyChain } from "../../memory-core/src/sync/crypto/chain.ts"
import { createRejectionCounter } from "../../memory-core/src/sync/crypto/rejection.ts"
import { pinTrustAnchor } from "../../memory-core/src/sync/crypto/trust-pin.ts"
import { createWorld, removeWorldStateDirs } from "../../memory-core/src/sync/recovery/testing/world.test-support.ts"
import { createCredentialStore, type CredentialStore } from "../../omo-opencode/src/cli/service-auth/keystore"
import type { Credentials } from "../../omo-opencode/src/cli/service-auth/protocol"
import { ACCOUNT_EXIT, runAccountVerb } from "../account-cli"

const homes: string[] = []
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})
afterAll(removeWorldStateDirs)

const credential = (deviceId: string, expiresInMs: number, refreshToken = `rt-${deviceId}`): Credentials => ({
  accessToken: `at-${deviceId}-${expiresInMs}`,
  accessTokenExpiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  refreshToken,
  device: { id: deviceId, name: `device ${deviceId}` },
  signingPrivateKey: "c2lnbmluZw==",
  sealingPrivateKey: "c2VhbGluZw==",
})

function memoryStore(initial: Credentials | null) {
  let value = initial
  const store: CredentialStore = {
    read: async () => value,
    write: async (next) => { value = next },
    clear: async () => { value = null },
  }
  return { store, current: () => value }
}

function run(store: CredentialStore, args: string[], options: { stdin?: string; api?: string; pinDir?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), "omo-account-cli-"))
  homes.push(home)
  const pinDir = options.pinDir ?? join(home, "sync-device")
  const out: string[] = []
  const err: string[] = []
  return runAccountVerb({
    api: options.api ?? "http://127.0.0.1:1",
    store,
    home,
    pinDir: () => pinDir,
    readStdin: async () => options.stdin ?? "",
    output: (line) => out.push(line),
    error: (line) => err.push(line),
  }, args).then((code) => ({ code, out: out.map((line) => JSON.parse(line) as Record<string, unknown>), err }))
}

function fakeService(answer: (body: Record<string, unknown>) => Response) {
  const refreshTokens: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/session/refresh") return new Response(null, { status: 404 })
      const body = (await req.json()) as Record<string, unknown>
      refreshTokens.push(String(body.refreshToken))
      return answer(body)
    },
  })
  return { api: `http://127.0.0.1:${server.port}`, refreshTokens, stop: () => server.stop(true) }
}

describe("omo account", () => {
  test("adopt stores the credential and show reports the device without any secret", async () => {
    const { store, current } = memoryStore(null)
    const adopted = await run(store, ["adopt"], { stdin: JSON.stringify(credential("dev_a", 3_600_000)) })
    expect(adopted.code).toBe(ACCOUNT_EXIT.ok)
    expect(current()?.device.id).toBe("dev_a")

    const shown = await run(store, ["show"])
    expect(shown.out).toEqual([{ signedIn: true, device: { id: "dev_a", name: "device dev_a" }, refreshState: "ok" }])
    expect(JSON.stringify(shown.out)).not.toContain("rt-dev_a")
  })

  test("adopt refuses a different device, writes nothing, and --replace takes over", async () => {
    const held = credential("dev_cli", 3_600_000)
    const { store, current } = memoryStore(held)
    const refused = await run(store, ["adopt"], { stdin: JSON.stringify(credential("dev_desk", 3_600_000)) })
    expect(refused.code).toBe(ACCOUNT_EXIT.conflict)
    expect(refused.out).toEqual([{ conflict: { device: { id: "dev_cli", name: "device dev_cli" } } }])
    expect(current()).toEqual(held)

    const replaced = await run(store, ["adopt", "--replace"], { stdin: JSON.stringify(credential("dev_desk", 3_600_000)) })
    expect(replaced.code).toBe(ACCOUNT_EXIT.ok)
    expect(current()?.device.id).toBe("dev_desk")
  })

  test("adopting the same device keeps the newer token, so an older copy cannot roll the refresh token back", async () => {
    const newer = credential("dev_a", 3_600_000, "rt-newer")
    const { store, current } = memoryStore(newer)
    const adopted = await run(store, ["adopt"], { stdin: JSON.stringify(credential("dev_a", 60_000, "rt-older")) })
    expect(adopted.code).toBe(ACCOUNT_EXIT.ok)
    expect(current()?.refreshToken).toBe("rt-newer")
  })

  test("adopt rejects input that is not a credential", async () => {
    const { store, current } = memoryStore(null)
    const result = await run(store, ["adopt"], { stdin: "{\"accessToken\":\"x\"}" })
    expect(result.code).toBe(ACCOUNT_EXIT.invalid)
    expect(current()).toBeNull()
  })

  test("token refreshes an expiring credential once and returns the new access token", async () => {
    const service = fakeService(() => Response.json({
      accessToken: "at-fresh", accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), refreshToken: "rt-next",
    }))
    try {
      const { store, current } = memoryStore(credential("dev_a", 1_000, "rt-first"))
      const result = await run(store, ["token"], { api: service.api })
      expect(result.code).toBe(ACCOUNT_EXIT.ok)
      expect(result.out[0]).toMatchObject({ accessToken: "at-fresh", device: { id: "dev_a" } })
      expect(service.refreshTokens).toEqual(["rt-first"])
      expect(current()?.refreshToken).toBe("rt-next")
    } finally {
      service.stop()
    }
  })

  test("a refused refresh ends the session: the item is cleared and token exits 5", async () => {
    const service = fakeService(() => Response.json(
      { error: { code: "reauth_required", message: "reused", retryable: false, requestId: "r" } }, { status: 401 }))
    try {
      const { store, current } = memoryStore(credential("dev_a", 1_000))
      const result = await run(store, ["token"], { api: service.api })
      expect(result.code).toBe(ACCOUNT_EXIT.ended)
      expect(current()).toBeNull()
    } finally {
      service.stop()
    }
  })

  test("signed out: token and export exit 4, show says signed out", async () => {
    const { store } = memoryStore(null)
    expect((await run(store, ["token"])).code).toBe(ACCOUNT_EXIT.signedOut)
    expect((await run(store, ["export"])).code).toBe(ACCOUNT_EXIT.signedOut)
    expect((await run(store, ["show"])).out).toEqual([{ signedIn: false }])
  })

  test("show --account reports whether this device joined memory sync for that account, from its trust pin", async () => {
    const world = await createWorld("acct-show")
    const pinDir = mkdtempSync(join(tmpdir(), "omo-account-pins-"))
    homes.push(pinDir)
    const { store } = memoryStore(credential("dev_a", 3_600_000))

    const before = await run(store, ["show", "--account", world.account], { pinDir })
    expect(before.out[0]).toMatchObject({ signedIn: true, sync: "not_joined" })

    const walked = await appendEntries(emptyChain(world.account, creatorAnchor(world.account, world.owner.keyring)), world.server.chain(world.account), createRejectionCounter())
    if (!walked.ok || walked.state.pin === null) throw new Error("the fixture genesis does not anchor")
    await pinTrustAnchor(pinDir, world.account, walked.state.pin)
    const after = await run(store, ["show", "--account", world.account], { pinDir })
    expect(after.out[0]).toMatchObject({ signedIn: true, sync: "joined" })

    expect((await run(store, ["show", "--account"], { pinDir })).code).toBe(ACCOUNT_EXIT.invalid)
  }, 30_000)

  test("export returns the stored credential and forget clears it", async () => {
    const held = credential("dev_a", 3_600_000)
    const { store, current } = memoryStore(held)
    expect((await run(store, ["export"])).out).toEqual([held])
    const forgot = await run(store, ["forget"])
    expect(forgot.out).toEqual([{ forgotten: true }])
    expect(current()).toBeNull()
  })
})

describe("omo account on a locked OS credential store (desktop#3509)", () => {
  test("every verb reports keychain locked as its own exit code, never a generic failure", async () => {
    const locked = () => Promise.reject(Object.assign(new Error("SecKeychain write failed (-25308)"), { code: "ERR_SECRETS_PLATFORM_ERROR" }))
    const store = createCredentialStore("http://127.0.0.1:1", { get: locked, set: locked, delete: locked }, "darwin")
    for (const [args, stdin] of [[["show"]], [["token"]], [["export"]], [["forget"]], [["adopt"], JSON.stringify(credential("dev_x", 60_000))]] as const) {
      const result = await run(store, [...args], stdin === undefined ? {} : { stdin })
      expect({ args, code: result.code, out: result.out }).toEqual({ args, code: ACCOUNT_EXIT.keychainLocked, out: [{ keychain: "locked" }] })
      expect(result.err.join("\n")).toContain("macOS Keychain is locked")
    }
  })

  test("any other credential-store failure stays a generic failure", async () => {
    const broken = () => Promise.reject(new Error("boom"))
    const store = createCredentialStore("http://127.0.0.1:1", { get: broken, set: broken, delete: broken }, "darwin")
    const result = await run(store, ["show"])
    expect(result.code).toBe(ACCOUNT_EXIT.failed)
    expect(result.out).toEqual([])
  })
})
