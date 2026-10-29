import { afterEach, expect, test } from "bun:test"

import { freshStateDir, newDevice, removeWorldStateDirs } from "../recovery/testing/world.test-support"
import { enableSync } from "./enable"
import { createAccountHttp } from "./http"
import { createPairingHttp } from "./pairing-http"
import { type ChainWireServer, startChainWireServer } from "./testing/chain-wire-server.test-support"

const servers: ChainWireServer[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  await removeWorldStateDirs()
})

test.each(["before_enable", "after_account_switch", "during_token"] as const)(
  "enable admits no further service mutations after retirement at %s",
  async (boundary) => {
    // Given: real service routes and an owner retired at a controlled dispatch boundary.
    const controller = new AbortController()
    const { keyring } = await newDevice()
    const server = startChainWireServer("retired-enable", [])
    servers.push(server)
    const token = server.tokenFor(keyring.principal())
    const dispatched: string[] = []
    const doFetch: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const path = new URL(String(input)).pathname
        dispatched.push(path)
        const response = await fetch(input, init)
        if (boundary === "after_account_switch" && path === "/v1/account/sync") controller.abort()
        return response
      },
      { preconnect: fetch.preconnect },
    )
    const http = {
      baseUrl: server.url,
      signal: controller.signal,
      token: async () => {
        if (boundary === "during_token") controller.abort()
        return token
      },
      fetch: doFetch,
    }
    const input = {
      account: "retired-enable",
      serviceDeviceId: "service-device",
      keyring,
      pinDir: freshStateDir(),
      chain: createAccountHttp(http),
      pairing: createPairingHttp(http),
      signal: controller.signal,
    }
    if (boundary === "before_enable") controller.abort()

    // When: the actual enable orchestration advances through its switch writes.
    const result = await enableSync(input).then(
      value => ({ kind: "returned" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    )

    // Then: the first committed switch stays committed, but later work is not dispatched.
    expect(dispatched).toEqual(boundary === "after_account_switch" ? ["/v1/account/sync"] : [])
    expect(result.kind).toBe("rejected")
  },
)
