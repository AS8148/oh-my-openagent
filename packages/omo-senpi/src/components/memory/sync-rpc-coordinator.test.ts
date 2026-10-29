import { afterEach, expect, test } from "bun:test"
import { registerSyncRpc } from "./sync-rpc-registration"
import type { SyncRpcAccount, SyncRpcContext, SyncRpcOptions, SyncRpcRegistration, SyncRpcRuntime } from "./sync-rpc-ports"
import { newDevice, removeWorldStateDirs } from "../../../../../memory-core/src/sync/recovery/testing/world.test-support"
import { createAccountHttp } from "../../../../../memory-core/src/sync/account/http"
import { createPairingHttp } from "../../../../../memory-core/src/sync/account/pairing-http"

type Handler = Parameters<SyncRpcRegistration["handle"]>[1]
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); await removeWorldStateDirs() })
const deferred = <T>() => Promise.withResolvers<T>()

function owner(id: string) {
  const abort = new AbortController()
  let retired = false
  const context: SyncRpcContext = {
    ownerId: id,
    disconnectSignal: abort.signal,
    admit: (dispatch) => { if (retired) throw new Error("retired"); return dispatch() },
  }
  return { context, retire: () => { retired = true; abort.abort() } }
}

async function setup() {
  const device = await newDevice()
  const accountAbort = new AbortController()
  const hostAbort = new AbortController()
  const sourceBarrier = deferred<void>()
  let holdSource = false
  let begins = 0
  let closes = 0
  let joins = 0
  let approvals = 0
  const joinDone = deferred<{ readonly kind: "joined" }>()
  const approvalCode = deferred<void>()
  const joinCode = deferred<void>()
  let claimHeld = false
  const runtime: SyncRpcRuntime = {
    enableSync: async () => ({ kind: "join_required" }),
    joinAccount: async (input) => {
      joins += 1
      input.onPendingCreated({ id: "p", expires_at: Date.now() + 60_000 })
      await joinCode.promise
      input.showCode("012345")
      return joinDone.promise
    },
    approveDevice: async (input) => {
      approvals += 1
      input.onAnswered({ id: input.pendingId, expires_at: Date.now() + 60_000 })
      await approvalCode.promise
      return await input.confirmCode("012345") ? { kind: "approved", seq: 2 } : { kind: "declined" }
    },
  }
  const http = { baseUrl: "https://unused.invalid", token: () => { throw new Error("unexpected HTTP request") } }
  const account: SyncRpcAccount = {
    descriptor: { serviceOrigin: http.baseUrl, accountId: "account", serviceDeviceId: "service-device", syncPrincipalId: device.keyring.principal().id, publicKeys: device.keyring.publicKeys(), generation: "generation-1" },
    signal: accountAbort.signal,
    isCurrent: async () => !accountAbort.signal.aborted,
    forOperation: async (authority) => {
      authority.admit(() => { begins += 1 })
      return {
        keyring: device.keyring,
        chain: createAccountHttp(http),
        pairing: createPairingHttp(http),
        devices: async () => [],
        close: async () => { closes += 1 },
      }
    },
  }
  const handlers = new Map<string, Handler>()
  const options: SyncRpcOptions = {
    source: async () => { if (holdSource) await sourceBarrier.promise; return account },
    runtime,
    claims: { acquire: async () => {
      if (claimHeld) return null
      claimHeld = true
      return { expiresAt: async () => undefined, release: async () => { claimHeld = false } }
    } },
    pinDir: "/unused",
    signal: hostAbort.signal,
    syncStatus: async () => ({ state: "paused" }),
  }
  const coordinator = registerSyncRpc({ handle: (name, handler) => { handlers.set(name, handler) } }, options)
  const call = async (verb: string, context: SyncRpcContext, data: unknown = {}): Promise<unknown> => {
    const handler = handlers.get(`omo.memory.sync.${verb}`)
    if (handler === undefined) throw new Error("missing method")
    return handler(data, context)
  }
  cleanups.push(async () => {
    sourceBarrier.resolve()
    joinCode.resolve()
    approvalCode.resolve()
    joinDone.resolve({ kind: "joined" })
    await coordinator.dispose()
  })
  return {
    call, runtime, account, accountAbort, hostAbort, coordinator,
    hold: () => { holdSource = true }, release: () => sourceBarrier.resolve(),
    showJoinCode: () => joinCode.resolve(), showApprovalCode: () => approvalCode.resolve(),
    finishJoin: () => joinDone.resolve({ kind: "joined" }),
    counts: () => ({ begins, closes, joins, approvals }),
  }
}

test("#given source resolution is held #when two enables race #then only one join opens", async () => {
  const f = await setup()
  const a = owner("a")
  f.hold()
  const first = f.call("enable", a.context)
  const second = f.call("enable", a.context)
  f.release()
  expect(await first).toMatchObject({ kind: "join_required", pairing: { pendingId: "p", code: null } })
  expect(await second).toEqual(await first)
  expect(f.counts().joins).toBe(1)
})

test("#given a live ceremony #when another owner reads or starts it #then state and authority stay private", async () => {
  const f = await setup()
  const a = owner("a")
  const b = owner("b")
  await f.call("enable", a.context)
  expect(await f.call("status", b.context)).toEqual({ sync: { state: "paused" }, enable: null, approvals: [] })
  expect(await f.call("enable", b.context, { ownerId: "a" })).toMatchObject({ kind: "refused" })
  expect(f.counts().joins).toBe(1)
})

test("#given an approval #when a foreign owner confirms #then its promise is not consumed", async () => {
  const f = await setup()
  const a = owner("a")
  const b = owner("b")
  await f.call("approve", a.context, { action: "begin", pendingId: "p" })
  f.showApprovalCode()
  expect(await f.call("approve", b.context, { action: "confirm", pendingId: "p", code: "012345" })).toMatchObject({ kind: "refused" })
  expect(await f.call("approve", a.context, { action: "confirm", pendingId: "p", code: "012345" })).toMatchObject({ outcome: { kind: "approved", seq: 2 }, code: null })
  expect(f.counts().approvals).toBe(1)
})

test("#given a displayed code #when a different six digit code is submitted #then approval declines once", async () => {
  const f = await setup()
  const a = owner("a")
  await f.call("approve", a.context, { action: "begin", pendingId: "p" })
  f.showApprovalCode()
  expect(await f.call("approve", a.context, { action: "confirm", pendingId: "p", code: "999999" })).toMatchObject({ outcome: { kind: "declined" }, code: null })
  expect(await f.call("approve", a.context, { action: "confirm", pendingId: "p", code: "012345" })).toMatchObject({ outcome: { kind: "declined" } })
  expect(f.counts().approvals).toBe(1)
})

test("#given source resolution is suspended #when the owner retires #then no operation port is opened", async () => {
  const f = await setup()
  const a = owner("a")
  f.hold()
  const pending = f.call("enable", a.context)
  a.retire()
  f.release()
  expect(await pending).toMatchObject({ kind: "refused" })
  expect(f.counts()).toEqual({ begins: 0, closes: 0, joins: 0, approvals: 0 })
})

test("#given approval waits for confirmation #when the account retires #then confirmation terminates and codes disappear", async () => {
  const f = await setup()
  const a = owner("a")
  await f.call("approve", a.context, { action: "begin", pendingId: "p" })
  f.showApprovalCode()
  f.accountAbort.abort()
  expect(await f.call("status", a.context)).toMatchObject({ kind: "unavailable" })
  expect(await f.call("approve", a.context, { action: "confirm", pendingId: "p", code: "012345" })).toMatchObject({ kind: "refused" })
})

test("#given a terminal approval #when status is pulled repeatedly #then the outcome survives until another start", async () => {
  const f = await setup()
  const a = owner("a")
  await f.call("approve", a.context, { action: "begin", pendingId: "p" })
  f.showApprovalCode()
  await f.call("approve", a.context, { action: "decline", pendingId: "p" })
  const expected = { sync: { state: "paused" }, enable: null, approvals: [{ pendingId: "p", expiresAt: expect.any(Number), code: null, outcome: { kind: "declined" } }] }
  expect(await f.call("status", a.context)).toEqual(expected)
  expect(await f.call("status", a.context)).toEqual(expected)
  expect(f.counts().closes).toBe(1)
})
