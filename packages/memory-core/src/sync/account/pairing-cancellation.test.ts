import { afterAll, afterEach, expect, test } from "bun:test"

import { creatorAnchor } from "../crypto/anchor.ts"
import { appendEntries, emptyChain } from "../crypto/chain.ts"
import { createRejectionCounter } from "../crypto/rejection.ts"
import { pinTrustAnchor } from "../crypto/trust-pin.ts"
import { createWorld, freshStateDir, newDevice, removeWorldStateDirs } from "../recovery/testing/world.test-support.ts"
import { approveDevice } from "./approve.ts"
import { createAccountHttp } from "./http.ts"
import { joinAccount } from "./join.ts"
import { approvalCommitment, newPairingNonce } from "./pairing.ts"
import { createPairingHttp } from "./pairing-http.ts"
import { type ChainWireServer, startChainWireServer } from "./testing/chain-wire-server.test-support.ts"

const servers: ChainWireServer[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
})
afterAll(removeWorldStateDirs)

// #11737: cancellation is an authority boundary, not only a rejected UI promise.
test("a retired join never opens a service pending row", async () => {
  // Given: an already disconnected owner and real account HTTP routes.
  const world = await createWorld("cancelled-join")
  const joining = await newDevice()
  const server = startChainWireServer(world.account, world.server.chain(world.account))
  servers.push(server)
  const options = { baseUrl: server.url, token: () => server.tokenFor(joining.principal) }
  const input = {
    account: world.account,
    keyring: joining.keyring,
    pinDir: freshStateDir(),
    chain: createAccountHttp(options),
    pairing: createPairingHttp(options),
    signal: AbortSignal.abort(),
    clock: { now: () => Number.POSITIVE_INFINITY, sleep: async () => { throw new Error("unexpected wait") } },
    showCode: () => { throw new Error("retired owner received a code") },
  }

  // When: the existing ceremony is asked to start with retired authority.
  const outcome = await joinAccount(input)

  // Then: it refuses without even opening a pairing row.
  expect(outcome.kind).toBe("refused")
  expect(server.pending()).toHaveLength(0)
})

test("disconnect at confirmation prevents approval signing and append", async () => {
  // Given: a real pinned member and a valid committed/revealed joining principal.
  const world = await createWorld("cancelled-confirm")
  const rows = world.server.chain(world.account)
  const walked = await appendEntries(emptyChain(world.account, creatorAnchor(world.account, world.owner.keyring)), rows, createRejectionCounter())
  if (!walked.ok || walked.state.pin === null) throw new Error("fixture genesis is not anchored")
  const pinDir = freshStateDir()
  await pinTrustAnchor(pinDir, world.account, walked.state.pin)
  const joining = await newDevice()
  const server = startChainWireServer(world.account, rows)
  servers.push(server)
  const options = { baseUrl: server.url, token: () => server.tokenFor(world.owner.principal) }
  const pairing = createPairingHttp(options)
  const nonce = newPairingNonce()
  const pending = await pairing.openPending(world.account, await approvalCommitment(world.account, { principal: joining.principal, nonce }))
  await pairing.revealPending(pending.id, joining.principal, nonce)
  const controller = new AbortController()
  const before = rows.length
  const input = {
    account: world.account,
    keyring: world.owner.keyring,
    pinDir,
    chain: createAccountHttp(options),
    pairing,
    clock: { now: () => 0, sleep: async () => { throw new Error("unexpected wait") } },
    pendingId: pending.id,
    signal: controller.signal,
    confirmCode: async () => {
      controller.abort()
      return true
    },
  }

  // When: the owner disconnects exactly as the confirmation promise resolves.
  const outcome = await approveDevice(input)

  // Then: no approval is appended for the retired owner.
  expect(outcome.kind).toBe("refused")
  expect(rows).toHaveLength(before)
})
