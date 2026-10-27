import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { CredentialStore } from "../../omo-opencode/src/cli/service-auth/keystore"
import type { Credentials } from "../../omo-opencode/src/cli/service-auth/protocol"
import { createSession } from "../../omo-opencode/src/cli/service-auth/session"
import { ACCOUNT_EXIT, runAccountVerb } from "../account-cli"

const homes: string[] = []
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

const credential = (deviceId: string): Credentials => ({
  accessToken: `at-${deviceId}`,
  accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  refreshToken: `rt-${deviceId}`,
  device: { id: deviceId, name: `device ${deviceId}` },
  signingPrivateKey: "c2lnbmluZw==",
  sealingPrivateKey: "c2VhbGluZw==",
})

function memoryStore(initial: Credentials | null): CredentialStore {
  let value = initial
  return {
    read: async () => value,
    write: async next => {
      value = next
    },
    clear: async () => {
      value = null
    },
  }
}

function machine(initial: Credentials | null) {
  const home = mkdtempSync(join(tmpdir(), "omo-logout-marker-"))
  homes.push(home)
  const server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 204 }) })
  const api = `http://127.0.0.1:${server.port}`
  const store = memoryStore(initial)
  const account = async (args: string[], stdin = "") => {
    const out: string[] = []
    const code = await runAccountVerb(
      { api, store, home, pinDir: () => join(home, "sync-device"), readStdin: async () => stdin, output: line => out.push(line), error: () => {} },
      args,
    )
    return { code, out: out.map(line => JSON.parse(line) as Record<string, unknown>) }
  }
  const session = createSession({ api, store, home })
  return { account, session, stop: () => server.stop(true) }
}

describe("omo logout leaves a sign-out marker the desktop can read (#11434)", () => {
  test("logout then token and export answer exit 10 with the signed-out device, show says signed out with it", async () => {
    const m = machine(credential("dev_a"))
    try {
      expect(await m.session.logout()).toBe(true)
      const token = await m.account(["token"])
      expect(token.code).toBe(ACCOUNT_EXIT.loggedOut)
      expect(token.out).toEqual([{ signedIn: false, signedOut: { device: "dev_a", at: expect.any(String) } }])
      expect((await m.account(["export"])).code).toBe(ACCOUNT_EXIT.loggedOut)
      const show = await m.account(["show"])
      expect(show.code).toBe(ACCOUNT_EXIT.ok)
      expect(show.out).toEqual([{ signedIn: false, signedOut: { device: "dev_a", at: expect.any(String) } }])
    } finally {
      m.stop()
    }
  })

  test("an empty store with no logout recorded still answers exit 4", async () => {
    const m = machine(null)
    try {
      expect(await m.account(["token"])).toEqual({ code: ACCOUNT_EXIT.signedOut, out: [{ signedIn: false }] })
      expect(await m.account(["show"])).toEqual({ code: ACCOUNT_EXIT.ok, out: [{ signedIn: false }] })
    } finally {
      m.stop()
    }
  })

  test("a sign-in after the logout (save or adopt) removes the marker", async () => {
    const m = machine(credential("dev_a"))
    try {
      await m.session.logout()
      await m.session.save(credential("dev_b"))
      await m.account(["forget"])
      expect((await m.account(["token"])).code).toBe(ACCOUNT_EXIT.signedOut)

      await m.session.logout()
      expect((await m.account(["adopt"], JSON.stringify(credential("dev_c")))).code).toBe(ACCOUNT_EXIT.ok)
      expect((await m.account(["token"])).code).toBe(ACCOUNT_EXIT.ok)
      await m.account(["forget"])
      expect((await m.account(["token"])).code).toBe(ACCOUNT_EXIT.signedOut)
    } finally {
      m.stop()
    }
  })
})
