import { expect, onTestFinished, spyOn, test } from "bun:test"
import type { Credentials } from "./protocol"
import { createSession } from "./session"
import { clock, fakeApi, grant, memorySecrets, privateKeys, refusal, temporaryHome } from "./test-support"

const expired: Credentials = { ...grant, ...privateKeys, accessTokenExpiresAt: "2000-01-01T00:00:00Z" }
const successor = { accessToken: "successor-access", accessTokenExpiresAt: "2099-01-01T00:00:00.000Z", refreshToken: "successor-refresh" }

const JOURNALED_KEY = "j".repeat(43)

type Seen = { readonly refreshToken: string; readonly key: string | null }

// Models sisyphuslabs/omo-service#628: a replay of the same token under the same
// Idempotency-Key gets the stored successor; any other reuse is refused as reuse.
function idempotentService(reply?: (seen: Seen, index: number) => Response | undefined) {
  const seen: Seen[] = []
  const committed = new Map<string, string>()
  let live = grant.refreshToken
  const api = fakeApi(async request => {
    const { refreshToken } = await request.json() as { refreshToken: string }
    const entry = { refreshToken, key: request.headers.get("idempotency-key") }
    seen.push(entry)
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(entry.key ?? "")) return refusal("invalid_request", undefined, 400)
    const scripted = reply?.(entry, seen.length)
    if (scripted) return scripted
    if (entry.key !== null && committed.get(entry.key) === refreshToken) return Response.json(successor)
    if (refreshToken !== live) return refusal("reauth_required", undefined, 401)
    live = successor.refreshToken
    if (entry.key !== null) committed.set(entry.key, refreshToken)
    return Response.json(successor)
  })
  return { api, seen }
}

function loseFirstAnswer() {
  const original = globalThis.fetch
  let calls = 0
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const response = await original(input, init)
      if (++calls === 1) { await response.arrayBuffer(); throw new TypeError("response lost") }
      return response
    }, { preconnect: original.preconnect }))
  onTestFinished(() => fetcher.mockRestore())
}

async function setup() {
  const time = clock()
  const home = await temporaryHome()
  return { time, home, open: (api: string, store: ReturnType<ReturnType<typeof memorySecrets>["store"]>) =>
    createSession({ api, store, home, now: time.now }) }
}

test("a committed refresh whose answer was lost recovers with the same token and Idempotency-Key", async () => {
  const service = idempotentService()
  const store = memorySecrets().store(service.api)
  await store.write(expired)
  const { time, open } = await setup()
  loseFirstAnswer()

  await expect(open(service.api, store).accessToken()).rejects.toMatchObject({ retryable: true })
  const journal = await store.read()
  expect(journal).toMatchObject({ ...expired, refreshState: "uncertain", refreshAttempt: { attempts: 1 } })
  const key = journal?.refreshAttempt?.idempotencyKey
  expect(key).toBeString()

  await expect(open(service.api, store).accessToken()).rejects.toMatchObject({ retryable: true })
  expect(service.seen).toHaveLength(1)

  await time.sleep(5_000)
  expect(await open(service.api, store).accessToken()).toBe(successor.accessToken)
  expect(service.seen).toEqual([
    { refreshToken: grant.refreshToken, key: key ?? "" },
    { refreshToken: grant.refreshToken, key: key ?? "" },
  ])
  const restored = await store.read()
  expect(restored).toMatchObject({ ...successor, device: grant.device })
  expect(restored).not.toHaveProperty("refreshState")
  expect(restored).not.toHaveProperty("refreshAttempt")
})

for (const code of ["unauthorized", "invalid_grant", "account_deleted", "reauth_required", "device_revoked"]) {
  test(`an enveloped ${code} refusal on the retry clears the store`, async () => {
    const service = idempotentService((_, index) => index === 2 ? refusal(code, undefined, code === "invalid_grant" ? 400 : 401) : undefined)
    const store = memorySecrets().store(service.api)
    await store.write(expired)
    const { time, open } = await setup()
    loseFirstAnswer()
    await expect(open(service.api, store).accessToken()).rejects.toThrow()
    await time.sleep(5_000)
    await expect(open(service.api, store).accessToken()).rejects.toThrow("Sign in again")
    expect(await store.read()).toBeNull()
    expect(service.seen).toHaveLength(2)
  })
}

for (const mode of ["503", "500-terminal-code", "no-envelope", "lost-again"]) {
  test(`a ${mode} retry stays uncertain with bounded backoff and keeps the same key`, async () => {
    const service = idempotentService((_, index) => {
      if (index !== 2) return undefined
      if (mode === "503") return refusal("unavailable", undefined, 503)
      if (mode === "500-terminal-code") return refusal("unauthorized", undefined, 500)
      if (mode === "no-envelope") return new Response("bad gateway", { status: 502 })
      return undefined
    })
    const store = memorySecrets().store(service.api)
    await store.write(expired)
    const { time, open } = await setup()
    const original = globalThis.fetch
    let calls = 0
    const fetcher = spyOn(globalThis, "fetch").mockImplementation(Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const response = await original(input, init)
        calls++
        if (calls === 1 || (mode === "lost-again" && calls === 2)) { await response.arrayBuffer(); throw new TypeError("response lost") }
        return response
      }, { preconnect: original.preconnect }))
    onTestFinished(() => fetcher.mockRestore())

    await expect(open(service.api, store).accessToken()).rejects.toThrow()
    const key = (await store.read())?.refreshAttempt?.idempotencyKey
    await time.sleep(5_000)
    await expect(open(service.api, store).accessToken()).rejects.toMatchObject({ retryable: true })
    const held = await store.read()
    expect(held).toMatchObject({ ...expired, refreshState: "uncertain", refreshAttempt: { idempotencyKey: key, attempts: 2 } })
    expect(Date.parse(held?.refreshAttempt?.nextAttemptAt ?? "")).toBe(time.now() + 10_000)

    await time.sleep(9_999)
    await expect(open(service.api, store).accessToken()).rejects.toThrow()
    expect(service.seen).toHaveLength(2)
    await time.sleep(1)
    expect(await open(service.api, store).accessToken()).toBe(successor.accessToken)
    expect(service.seen.map(entry => entry.key)).toEqual([key, key, key])
    expect(new Set(service.seen.map(entry => entry.refreshToken))).toEqual(new Set([grant.refreshToken]))
  })
}

test("backoff doubles per failed retry and is capped at five minutes", async () => {
  const service = idempotentService(() => refusal("unavailable", undefined, 503))
  const store = memorySecrets().store(service.api)
  await store.write({ ...expired, refreshState: "uncertain", refreshAttempt: { idempotencyKey: JOURNALED_KEY, attempts: 0, nextAttemptAt: "2000-01-01T00:00:00Z" } })
  const { time, open } = await setup()
  const delays: number[] = []
  for (let round = 0; round < 8; round++) {
    await expect(open(service.api, store).accessToken()).rejects.toThrow()
    const delay = Date.parse((await store.read())?.refreshAttempt?.nextAttemptAt ?? "") - time.now()
    delays.push(delay)
    await time.sleep(delay)
  }
  expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000])
  expect(new Set(service.seen.map(entry => entry.key))).toEqual(new Set([JOURNALED_KEY]))
})

for (const seeded of ["fresh", "resend"]) {
  test(`a run killed after its ${seeded} send leaves a persisted backoff that the next run honours`, async () => {
    const service = idempotentService()
    const base = memorySecrets().store(service.api)
    await base.write(seeded === "fresh" ? expired
      : { ...expired, refreshState: "uncertain", refreshAttempt: { idempotencyKey: JOURNALED_KEY, attempts: 1, nextAttemptAt: "2000-01-01T00:00:00Z" } })
    const killed = { ...base, write: async (value: Credentials) => {
      if (service.seen.length > 0) throw new Error("process killed")
      await base.write(value)
    } }
    loseFirstAnswer()
    const { time, open } = await setup()
    await expect(open(service.api, killed).accessToken()).rejects.toThrow()
    expect(service.seen).toHaveLength(1)
    const delay = Date.parse((await base.read())?.refreshAttempt?.nextAttemptAt ?? "") - time.now()
    expect(delay).toBe(seeded === "fresh" ? 5_000 : 10_000)
    await expect(open(service.api, base).accessToken()).rejects.toMatchObject({ retryable: true })
    expect(service.seen).toHaveLength(1)
    await time.sleep(delay)
    expect(await open(service.api, base).accessToken()).toBe(successor.accessToken)
    expect(service.seen).toHaveLength(2)
  })
}

test("a 429 on a resend honours a Retry-After longer than the backoff", async () => {
  const service = idempotentService((_, index) => index === 1
    ? Response.json({ error: { code: "rate_limited", message: "slow down", retryable: true, requestId: "test" } }, { status: 429, headers: { "retry-after": "30" } })
    : undefined)
  const store = memorySecrets().store(service.api)
  await store.write({ ...expired, refreshState: "uncertain", refreshAttempt: { idempotencyKey: JOURNALED_KEY, attempts: 1, nextAttemptAt: "2000-01-01T00:00:00Z" } })
  const { time, open } = await setup()
  await expect(open(service.api, store).accessToken()).rejects.toMatchObject({ retryable: true })
  const held = await store.read()
  expect(held).toMatchObject({ refreshState: "uncertain", refreshAttempt: { idempotencyKey: JOURNALED_KEY, attempts: 2 } })
  expect(Date.parse(held?.refreshAttempt?.nextAttemptAt ?? "")).toBe(time.now() + 30_000)
  await time.sleep(29_999)
  await expect(open(service.api, store).accessToken()).rejects.toThrow()
  expect(service.seen).toHaveLength(1)
  await time.sleep(1)
  expect(await open(service.api, store).accessToken()).toBe(successor.accessToken)
})

test("each attempt gets a fresh 256-bit base64url Idempotency-Key that stays fixed across its resends", async () => {
  const service = idempotentService()
  const store = memorySecrets().store(service.api)
  await store.write(expired)
  const { time, open } = await setup()
  loseFirstAnswer()
  await expect(open(service.api, store).accessToken()).rejects.toThrow()
  await time.sleep(5_000)
  expect(await open(service.api, store).accessToken()).toBe(successor.accessToken)
  const restored = await store.read()
  if (restored === null) throw new Error("restored record missing")
  await store.write({ ...restored, accessTokenExpiresAt: "2000-01-01T00:00:00Z" })
  expect(await open(service.api, store).accessToken()).toBe(successor.accessToken)
  const keys = service.seen.map(entry => entry.key ?? "")
  expect(keys).toHaveLength(3)
  for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(keys[1]).toBe(keys[0])
  expect(keys[2]).not.toBe(keys[0])
})

test("a pending attempt journaled with an out-of-contract draft key is re-keyed before its resend of the same token", async () => {
  const draftKey = "0f8e3b52-6d1c-4a8e-9b7f-2c4d5e6f7a8b"
  const service = idempotentService()
  const base = memorySecrets().store(service.api)
  await base.write({ ...expired, refreshState: "uncertain", refreshAttempt: { idempotencyKey: draftKey, attempts: 1, nextAttemptAt: "2000-01-01T00:00:00Z" } })
  const journals: Credentials[] = []
  const store = { ...base, write: async (value: Credentials) => { journals.push(value); await base.write(value) } }
  const { open } = await setup()
  expect(await open(service.api, store).accessToken()).toBe(successor.accessToken)
  const rekeyed = journals[0]?.refreshAttempt?.idempotencyKey
  expect(rekeyed).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(service.seen).toEqual([{ refreshToken: grant.refreshToken, key: rekeyed ?? "" }])
})

for (const phase of ["first send", "resend"]) {
  test(`invalid_request on the ${phase} proves the token unconsumed and restores the settled record`, async () => {
    const service = idempotentService((_, index) => index === 1 ? refusal("invalid_request", undefined, 400) : undefined)
    const store = memorySecrets().store(service.api)
    await store.write(phase === "first send" ? expired
      : { ...expired, refreshState: "uncertain", refreshAttempt: { idempotencyKey: JOURNALED_KEY, attempts: 1, nextAttemptAt: "2000-01-01T00:00:00Z" } })
    const { open } = await setup()
    await expect(open(service.api, store).accessToken()).rejects.toMatchObject({ code: "invalid_request", status: 400 })
    expect(await store.read()).toEqual(expired)
    expect(await open(service.api, store).accessToken()).toBe(successor.accessToken)
    expect(service.seen).toHaveLength(2)
    expect(service.seen[1]?.key).not.toBe(service.seen[0]?.key)
  })

  for (const [code, status] of [["forbidden", 403], ["not_found", 404], ["entitlement_required", 402], ["brand_new_code", 400]] as const) {
    test(`an enveloped ${code} on the ${phase} is a definite answer that ends the session`, async () => {
      const service = idempotentService((_, index) => index === 1 ? refusal(code, undefined, status) : undefined)
      const store = memorySecrets().store(service.api)
      await store.write(phase === "first send" ? expired
        : { ...expired, refreshState: "uncertain", refreshAttempt: { idempotencyKey: JOURNALED_KEY, attempts: 1, nextAttemptAt: "2000-01-01T00:00:00Z" } })
      const { open } = await setup()
      await expect(open(service.api, store).accessToken()).rejects.toThrow("Sign in again")
      expect(await store.read()).toBeNull()
      expect(service.seen).toHaveLength(1)
    })
  }
}

test("a nextAttemptAt beyond the five-minute cap after a backward clock jump is treated as due", async () => {
  const service = idempotentService()
  const store = memorySecrets().store(service.api)
  const { time, open } = await setup()
  await store.write({ ...expired, refreshState: "uncertain", refreshAttempt: {
    idempotencyKey: JOURNALED_KEY, attempts: 3, nextAttemptAt: new Date(time.now() + 300_001).toISOString(),
  } })
  expect(await open(service.api, store).accessToken()).toBe(successor.accessToken)
  expect(service.seen).toEqual([{ refreshToken: grant.refreshToken, key: JOURNALED_KEY }])
})

test("two concurrent invocations on an uncertain record send one request under the session lock", async () => {
  const service = idempotentService()
  const secrets = memorySecrets()
  const store = secrets.store(service.api)
  await store.write({ ...expired, refreshState: "uncertain", refreshAttempt: { idempotencyKey: JOURNALED_KEY, attempts: 1, nextAttemptAt: "2000-01-01T00:00:00Z" } })
  const { open } = await setup()
  const results = await Promise.all([open(service.api, store).accessToken(), open(service.api, store).accessToken()])
  expect(results).toEqual([successor.accessToken, successor.accessToken])
  expect(service.seen).toEqual([{ refreshToken: grant.refreshToken, key: JOURNALED_KEY }])
})

test("a keyless uncertain record from an older CLI gets one persisted key before its first resend", async () => {
  const service = idempotentService(() => refusal("unavailable", undefined, 503))
  const store = memorySecrets().store(service.api)
  await store.write({ ...expired, refreshState: "uncertain" })
  const { time, open } = await setup()
  await expect(open(service.api, store).accessToken()).rejects.toThrow()
  const key = (await store.read())?.refreshAttempt?.idempotencyKey
  expect(key).toBeString()
  await time.sleep(5_000)
  await expect(open(service.api, store).accessToken()).rejects.toThrow()
  expect(service.seen.map(entry => entry.key)).toEqual([key, key])
})

test("the first send of a fresh refresh carries the journaled Idempotency-Key", async () => {
  const service = idempotentService()
  const store = memorySecrets().store(service.api)
  await store.write(expired)
  const writes: Credentials[] = []
  const recording = { ...store, write: async (value: Credentials) => { writes.push(value); await store.write(value) } }
  const { time, home } = await setup()
  expect(await createSession({ api: service.api, store: recording, home, now: time.now }).accessToken()).toBe(successor.accessToken)
  expect(writes[0]).toMatchObject({ refreshState: "uncertain", refreshAttempt: { attempts: 1 } })
  expect(service.seen).toEqual([{ refreshToken: grant.refreshToken, key: writes[0]?.refreshAttempt?.idempotencyKey ?? "" }])
})
