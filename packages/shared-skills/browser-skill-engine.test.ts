/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { guardOmowright } from "./skills/browser/scripts/omowright.mjs"

type Json = Record<string, unknown>

function fakeRaw() {
  const calls: Array<[string, ...unknown[]]> = []
  const record =
    (name: string, result: unknown = { from: name }) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args])
      return result
    }
  const raw = {
    calls,
    connectBrowserSkill: record("connectBrowserSkill"),
    connectPipe: record("connectPipe"),
    connectCloakProfile: record("connectCloakProfile"),
    connect: record("connect"),
    createCua: record("createCua"),
    emulate: record("emulate"),
    bskSnapshot: record("bskSnapshot"),
    bskDoctor: record("bskDoctor"),
    DEVICE_PRESETS: { phone: { width: 390 } },
  }
  return raw
}

function fakeHost(answer?: (args: Json) => Json) {
  const log: Array<{ tool: string; args: Json }> = []
  return {
    log,
    async listTools(): Promise<string[]> {
      return ["omo_desktop_toolkit"]
    },
    async callTool(tool: string, args: Json): Promise<Json> {
      log.push({ tool, args })
      return answer === undefined ? { details: { ok: false, reason: "unavailable" } } : answer(args)
    },
  }
}

const RAW_EXPORTS = ["connectBrowserSkill", "connectPipe", "connectCloakProfile", "connect", "createCua", "emulate", "bskSnapshot", "bskDoctor", "DEVICE_PRESETS"] as const

describe("inside OmO Desktop the library is the terminal's, plus the app's built-in browser", () => {
  test("#given no OMO_BROWSER_ENGINE #when the library loads #then it is the raw library", () => {
    const raw = fakeRaw()

    expect(guardOmowright(raw, { env: {}, host: fakeHost() })).toBe(raw)
  })

  for (const engine of ["builtin", "connected", "none", "something-new"]) {
    test(`#given OMO_BROWSER_ENGINE=${engine} #when the library loads #then every export is the terminal's own, and connectBuiltinBrowser is added`, () => {
      const raw = fakeRaw()

      const library = guardOmowright(raw, { env: { OMO_BROWSER_ENGINE: engine }, host: fakeHost() }) as unknown as Record<string, unknown>

      for (const name of RAW_EXPORTS) expect(library[name]).toBe(raw[name])
      expect(typeof library.connectBuiltinBrowser).toBe("function")
    })

    test(`#given OMO_BROWSER_ENGINE=${engine} #when the agent starts its own browser or the user's #then it runs as in the terminal and nothing is asked of the app`, async () => {
      const raw = fakeRaw()
      const host = fakeHost()
      const library = guardOmowright(raw, { env: { OMO_BROWSER_ENGINE: engine }, host })

      expect(await library.connectPipe({ headless: true })).toEqual({ from: "connectPipe" })
      expect(await library.connectBrowserSkill({ name: "task" })).toEqual({ from: "connectBrowserSkill" })

      expect(raw.calls).toEqual([["connectPipe", { headless: true }], ["connectBrowserSkill", { name: "task" }]])
      expect(host.log).toEqual([])
    })
  }
})

describe("the app's built-in browser", () => {
  test("#given the app grants it #when connectBuiltinBrowser runs #then OmOWright attaches to the granted endpoint with the token file's token, and re-acquires on refresh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omo-toolkit-test-"))
    try {
      const tokenFile = join(dir, "browser.token")
      writeFileSync(tokenFile, "first-token\n", { mode: 0o600 })
      const grant = { endpoint: "http://127.0.0.1:41234/toolkit/browser", tokenFile }
      const host = fakeHost(() => ({ details: { ok: true, grant } }))
      const attached: Array<{ url: string; options: { client: { authorizer: { resolveAuthorization: (o?: { forceRefresh?: boolean }) => Promise<string> } } } }> = []
      const raw = { ...fakeRaw(), connect: async (url: string, options: never) => { attached.push({ url, options }); return { kind: "connection" } } }
      const library = guardOmowright(raw, { env: { OMO_BROWSER_ENGINE: "connected" }, host }) as unknown as { connectBuiltinBrowser: () => Promise<unknown> }

      expect(await library.connectBuiltinBrowser()).toEqual({ kind: "connection" })
      expect(attached[0]?.url).toBe(grant.endpoint)
      const authorizer = attached[0]!.options.client.authorizer
      expect(await authorizer.resolveAuthorization()).toBe("Bearer first-token")
      writeFileSync(tokenFile, "rotated-token\n", { mode: 0o600 })
      expect(await authorizer.resolveAuthorization({ forceRefresh: true })).toBe("Bearer rotated-token")
      expect(host.log).toEqual([
        { tool: "omo_desktop_toolkit", args: { op: "acquire", toolkit: "browser" } },
        { tool: "omo_desktop_toolkit", args: { op: "acquire", toolkit: "browser" } },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("#given the app does not offer it #when connectBuiltinBrowser runs #then one plain error says why and that the other browsers work as usual, and no browser is attached", async () => {
    for (const [details, reason] of [
      [{ ok: false, reason: "unavailable" }, "unavailable"],
      [{ ok: false, reason: "timeout" }, "timeout"],
      [undefined, "unavailable"],
    ] as const) {
      const raw = fakeRaw()
      const library = guardOmowright(raw, { env: { OMO_BROWSER_ENGINE: "builtin" }, host: fakeHost(() => (details === undefined ? {} : { details })) }) as unknown as {
        connectBuiltinBrowser: () => Promise<unknown>
      }

      const error = await library.connectBuiltinBrowser().then(() => undefined, (cause: unknown) => cause)

      expect((error as { code?: string }).code).toBe("browser_builtin_unavailable")
      expect((error as { reason?: string }).reason).toBe(reason)
      expect(raw.calls).toEqual([])
    }
  })

  test("#given a kernel without the app's toolkit #when connectBuiltinBrowser runs #then the same plain error, nothing attached", async () => {
    const raw = fakeRaw()
    const library = guardOmowright(raw, { env: { OMO_BROWSER_ENGINE: "builtin" }, host: undefined }) as unknown as { connectBuiltinBrowser: () => Promise<unknown> }

    const error = await library.connectBuiltinBrowser().then(() => undefined, (cause: unknown) => cause)

    expect((error as { code?: string }).code).toBe("browser_builtin_unavailable")
    expect(raw.calls).toEqual([])
  })
})
