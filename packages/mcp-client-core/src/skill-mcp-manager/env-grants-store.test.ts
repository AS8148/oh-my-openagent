// Bun port of senpi 1cbe1594e353126ab8016bb0183ab82ffc5715d5: test/suite/regressions/3796-grants-store.test.ts.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import * as fsPromises from "node:fs/promises"
import * as timers from "node:timers/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import { addGrant, declarationDigest, list, observe, read, resolveGrantsStorePath, revoke, type GrantObservation } from "./env-grants-store"
import { createFileGrantStore } from "./env-grant-store"

let root: string
let stop: (() => void) | undefined
const restorers: (() => void)[] = []
const pendingTimers = new Set<ReturnType<typeof setTimeout>>()
const label = { project: "/synthetic/project", skill: "carrier", server: "probe" }
const identity = declarationDigest({ command: "synthetic-probe" })
const platform = Object.getOwnPropertyDescriptor(process, "platform")!
beforeEach(() => { root = fs.mkdtempSync(join(tmpdir(), "omo-10693-store-")) })
afterEach(() => {
  Object.defineProperty(process, "platform", platform)
  stop?.()
  stop = undefined
  for (const restore of restorers.splice(0)) restore()
  for (const timer of pendingTimers) clearTimeout(timer)
  pendingTimers.clear()
  fs.rmSync(root, { recursive: true, force: true })
})
function observationStream() {
  const events: GrantObservation[] = []
  const waiters = new Set<{ predicate: (event: GrantObservation) => boolean; resolve: (event: GrantObservation) => void }>()
  return {
    events,
    listener(event: GrantObservation) {
      events.push(event)
      for (const waiter of waiters) if (waiter.predicate(event)) {
        waiters.delete(waiter)
        waiter.resolve(event)
      }
    },
    next(predicate: (event: GrantObservation) => boolean): Promise<GrantObservation> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingTimers.delete(timer)
          waiters.delete(waiter)
          reject(new Error("Expected grant observation did not arrive"))
        }, 10_000)
        pendingTimers.add(timer)
        const waiter = { predicate, resolve: (event: GrantObservation) => {
          clearTimeout(timer); pendingTimers.delete(timer); resolve(event)
        } }
        waiters.add(waiter)
      })
    },
  }
}

test("resolves under the caller's configured engine directory", () => {
  expect(resolveGrantsStorePath(root)).toBe(join(root, "mcp-env-grants.json"))
})

test("merges concurrent atomic writers and revokes only the selected identity", async () => {
  const path = resolveGrantsStorePath(root)
  const second = declarationDigest({ command: "synthetic-second" })
  await Promise.all([
    addGrant(path, identity, label, ["ODD_DSN"]),
    addGrant(path, second, label, ["ODD_COOKIE"]),
  ])
  const snapshot = await read(path)
  expect(snapshot.generation).toBe(2)
  expect(snapshot.grants[identity]?.names).toEqual(["ODD_DSN"])
  expect(snapshot.grants[second]?.names).toEqual(["ODD_COOKIE"])
  await revoke(path, identity)
  expect((await read(path)).generation).toBe(3)
  expect((await list(path)).map((grant) => grant.digest)).toEqual([second])
  expect(JSON.parse(fs.readFileSync(path, "utf8"))).toEqual({
    version: 1, generation: 3, grants: { [second]: { label, names: ["ODD_COOKIE"] } },
  })
  expect(fs.readdirSync(root)).toEqual(["mcp-env-grants.json"])
})

test("keeps valid non-identifier environment names and rejects names with = or NUL", async () => {
  const path = resolveGrantsStorePath(root)
  await addGrant(path, identity, label, ["ProgramFiles(x86)", "odd-name"])
  expect((await read(path)).grants[identity]?.names).toEqual(["ProgramFiles(x86)", "odd-name"])
  await expect(addGrant(path, identity, label, ["A=B"])).rejects.toThrow()
  await expect(addGrant(path, identity, label, ["A\0B"])).rejects.toThrow()
  expect((await read(path)).generation).toBe(1)
})

test("failed rename leaves no grant, temporary file or lock", async () => {
  const path = resolveGrantsStorePath(root)
  fs.mkdirSync(path)
  await expect(addGrant(path, identity, label, ["ODD_DSN"])).rejects.toThrow()
  expect((await read(path)).grants).toEqual({})
  expect(fs.readdirSync(root)).toEqual(["mcp-env-grants.json"])
})

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
  test(`retries a Windows ${code} replace without repeating the grant mutation`, async () => {
    // given
    const path = resolveGrantsStorePath(root)
    await addGrant(path, identity, label, ["OLD"])
    Object.defineProperty(process, "platform", { value: "win32" })
    const error = Object.assign(new Error("synthetic open handle"), { code })
    const rename = spyOn(fsPromises, "rename").mockRejectedValueOnce(error).mockRejectedValueOnce(error)
    const delay = spyOn(timers, "setTimeout").mockResolvedValue(undefined)
    restorers.push(() => rename.mockRestore(), () => delay.mockRestore())
    // when
    const snapshot = await addGrant(path, identity, label, ["NEW"])
    // then
    expect(rename).toHaveBeenCalledTimes(3)
    expect(delay.mock.calls.map(([ms]) => ms)).toEqual([50, 100])
    expect(snapshot.generation).toBe(2)
    expect((await read(path)).grants[identity]?.names).toEqual(["NEW", "OLD"])
    expect(fs.readdirSync(root)).toEqual(["mcp-env-grants.json"])
  })
}

test("bounds Windows replace retries, preserves the old store and releases the lock", async () => {
  // given
  const path = resolveGrantsStorePath(root)
  await addGrant(path, identity, label, ["OLD"])
  Object.defineProperty(process, "platform", { value: "win32" })
  const error = Object.assign(new Error("synthetic open handle"), { code: "EPERM" })
  const rename = spyOn(fsPromises, "rename").mockRejectedValue(error)
  const delay = spyOn(timers, "setTimeout").mockResolvedValue(undefined)
  restorers.push(() => rename.mockRestore(), () => delay.mockRestore())
  // when / then
  await expect(addGrant(path, identity, label, ["NEW"])).rejects.toBe(error)
  expect(rename).toHaveBeenCalledTimes(6)
  expect(delay.mock.calls.map(([ms]) => ms)).toEqual([50, 100, 200, 400, 800])
  expect((await read(path)).generation).toBe(1)
  expect((await read(path)).grants[identity]?.names).toEqual(["OLD"])
  expect(fs.readdirSync(root)).toEqual(["mcp-env-grants.json"])
  rename.mockRestore()
  await addGrant(path, identity, label, ["AFTER"])
  expect((await read(path)).generation).toBe(2)
})

for (const [os, code] of [
  ["linux", "EPERM"],
  ["linux", "EACCES"],
  ["linux", "EBUSY"],
  ["win32", "ENOENT"],
]) {
  test(`does not retry ${code} on ${os}`, async () => {
    // given
    Object.defineProperty(process, "platform", { value: os })
    const error = Object.assign(new Error("synthetic rename failure"), { code })
    const rename = spyOn(fsPromises, "rename").mockRejectedValue(error)
    const delay = spyOn(timers, "setTimeout").mockResolvedValue(undefined)
    restorers.push(() => rename.mockRestore(), () => delay.mockRestore())
    // when / then
    await expect(addGrant(resolveGrantsStorePath(root), identity, label, ["NEW"])).rejects.toBe(error)
    expect(rename).toHaveBeenCalledTimes(1)
    expect(delay).not.toHaveBeenCalled()
    expect(fs.readdirSync(root)).toEqual([])
  })
}

test("watches creation and atomic replacements from before the store exists", async () => {
  const path = resolveGrantsStorePath(join(root, "not-created-yet"))
  const stream = observationStream()
  stop = await observe(path, stream.listener)
  const created = stream.next((event) => event.snapshot.generation === 1)
  await addGrant(path, identity, label, ["ODD_DSN"])
  expect((await created).snapshot.grants[identity]?.names).toEqual(["ODD_DSN"])
  const revoked = stream.next((event) => event.snapshot.generation === 2)
  await revoke(path, identity)
  expect((await revoked).snapshot.grants[identity]).toBeUndefined()
  const latest = stream.next((event) => event.snapshot.generation >= 4)
  await addGrant(path, identity, label, ["ODD_DSN"])
  await revoke(path, identity)
  expect((await latest).snapshot.grants[identity]).toBeUndefined()
}, 15_000)

test("fallback reconciles skipped revoke/regrant and file recreation conservatively", async () => {
  const watch = spyOn(fs, "watch").mockImplementation(() => { throw new Error("synthetic unavailable watch") })
  let tick: () => void = () => { throw new Error("Fallback interval was not armed") }
  let intervalMs: number | undefined
  const fakeSetInterval = (callback: TimerHandler, ms?: number) => {
    tick = () => { if (typeof callback === "function") callback() }
    intervalMs = ms
    return unsafeTestValue<ReturnType<typeof setInterval>>({ unref() {} })
  }
  const interval = spyOn(globalThis, "setInterval").mockImplementation(unsafeTestValue<typeof setInterval>(fakeSetInterval))
  const clear = spyOn(globalThis, "clearInterval").mockImplementation(() => {})
  restorers.push(() => watch.mockRestore(), () => interval.mockRestore(), () => clear.mockRestore())
  const path = resolveGrantsStorePath(root)
  await addGrant(path, identity, label, ["ODD_DSN"])
  const stream = observationStream()
  stop = await observe(path, stream.listener)
  expect(intervalMs).toBe(5000)
  expect(watch).toHaveBeenCalled()
  await revoke(path, identity)
  await addGrant(path, identity, label, ["ODD_DSN"])
  const skipped = stream.next((event) => event.snapshot.generation === 3)
  tick()
  expect((await skipped).conservative).toBe(true)
  fs.rmSync(path)
  await addGrant(path, identity, label, ["ODD_DSN"])
  const recreated = stream.next((event) => event.snapshot.generation === 1)
  tick()
  expect((await recreated).conservative).toBe(true)
  expect(stream.events.at(-1)?.snapshot.grants[identity]?.names).toEqual(["ODD_DSN"])
})

test("legacy store port writes exactly the shared schema and observes native writes", async () => {
  const store = createFileGrantStore(root)
  const path = resolveGrantsStorePath(root)
  const event = Promise.withResolvers<void>()
  stop = store.watch((observation) => {
    if (observation?.snapshot.generation === 2) event.resolve()
  })
  await store.add(identity, { label, names: ["Z", "A", "A"] })
  await addGrant(path, identity, label, ["B"])
  const timeout = setTimeout(() => event.reject(new Error("Shared store event did not arrive")), 10_000)
  try {
    await event.promise
    expect((await store.read()).grants[identity]?.names).toEqual(["A", "B", "Z"])
    expect(await store.list()).toEqual({ [identity]: { label, names: ["A", "B", "Z"] } })
    expect(await store.digest()).toBe(declarationDigest(await read(path)))
    await store.revoke(identity)
    expect((await read(path)).grants).toEqual({})
    expect(fs.readdirSync(root)).toEqual(["mcp-env-grants.json"])
  } finally { clearTimeout(timeout) }
}, 15_000)
