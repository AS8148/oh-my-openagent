import { describe, expect, test } from "bun:test"
import { A, credentials, fakeKeychain, helperSession } from "./fake-keychain.test-support"

const stored = JSON.stringify(credentials)
const fresh = { ...credentials, accessToken: "fresh-access", refreshToken: "fresh-refresh" }

// Row 8b, ruled 2026-10-28: only a completed, user-initiated sign-in may move aside an item this machine cannot read.
describe("re-login over an item nobody here can read (#11262 addendum row 8b)", () => {
  test("#given the item's creator is gone and only a password dialog is left #when read #then it reads as signed out, with no dialog", async () => {
    const keychain = fakeKeychain()
    keychain.put(A, stored, "runtime", "other")
    const { store } = await helperSession(keychain)
    expect(await store.read()).toBeNull()
    expect(keychain.stats.approves).toBe(0)
  })

  test("#given that state #when the user signs in again #then the old item moves to .old and the new one is the helper's, and later reads need no dialog", async () => {
    const keychain = fakeKeychain()
    keychain.put(A, stored, "runtime", "other")
    const { store, session } = await helperSession(keychain)
    await session.save(fresh)
    expect(keychain.items.get(A)).toMatchObject({ owner: "helper", marker: true })
    expect(JSON.parse(keychain.items.get(A)?.value ?? "null")).toEqual(fresh)
    expect(keychain.items.get(`${A}.old`)?.owner).toBe("runtime")
    expect(await store.read()).toEqual(fresh)
    expect(await session.accessToken()).toBe("fresh-access")
    expect(keychain.stats).toEqual({ approves: 0, unleasedMutations: 0 })
  })

  test("#given that state #when adopt (or a refresh) writes #then the unreadable item is never retired", async () => {
    const keychain = fakeKeychain()
    keychain.put(A, stored, "runtime", "other")
    const { session } = await helperSession(keychain)
    await session.update(async (_current, view) => view.write(fresh))
    expect(keychain.items.get(A)?.owner).toBe("runtime")
    expect(keychain.items.has(`${A}.old`)).toBe(false)
    expect(keychain.events.some(event => event.startsWith("retire"))).toBe(false)
  })

  test("#given a non-owned .old already left over #when the user signs in again #then the item retires to .old.1 and the save succeeds (RULING-73)", async () => {
    const keychain = fakeKeychain()
    keychain.put(A, stored, "runtime", "other")
    keychain.put(`${A}.old`, stored, "runtime", "other")
    const { store, session } = await helperSession(keychain)
    await session.save(fresh)
    expect(keychain.items.get(A)?.owner).toBe("helper")
    expect(keychain.items.get(`${A}.old.1`)?.owner).toBe("runtime")
    expect(await store.read()).toEqual(fresh)
    expect(keychain.stats).toEqual({ approves: 0, unleasedMutations: 0 })
  })

  test("#given all 8 retire slots hold copies nobody here can remove #when the user signs in again #then one actionable failure, no dialog and no retry", async () => {
    const keychain = fakeKeychain()
    keychain.put(A, stored, "runtime", "other")
    for (const suffix of [".old", ".old.1", ".old.2", ".old.3", ".old.4", ".old.5", ".old.6", ".old.7"]) keychain.put(`${A}${suffix}`, stored, "runtime", "other")
    const { session } = await helperSession(keychain)
    await expect(session.save(fresh)).rejects.toThrow("Open Keychain Access")
    expect(keychain.events.filter(event => event.startsWith("retire"))).toHaveLength(1)
    expect(keychain.stats.approves).toBe(0)
    expect(keychain.items.get(A)?.owner).toBe("runtime")
  })
})

describe("migration with a leftover .old (#11262 RULING-73)", () => {
  test("#given an approvable item and a non-owned .old #when the token is used #then it still migrates to the helper, into the next slot", async () => {
    const keychain = fakeKeychain()
    keychain.put(A, stored, "runtime", "ours")
    keychain.put(`${A}.old`, stored, "runtime", "other")
    const { session } = await helperSession(keychain)
    expect(await session.accessToken()).toBe(credentials.accessToken)
    expect(keychain.items.get(A)?.owner).toBe("helper")
    expect(keychain.items.get(`${A}.old`)?.owner).toBe("runtime")
    expect(keychain.stats).toEqual({ approves: 1, unleasedMutations: 0 })
  })
})
