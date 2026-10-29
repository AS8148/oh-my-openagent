import { afterEach, expect, spyOn, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import * as fs from "node:fs"
import { join } from "node:path"
import { withLock } from "../../locks/acquire.ts"
import { createLockRecord } from "../../locks/lock-record.ts"
import { pinTrustAnchor } from "../crypto/trust-pin.ts"
import { walk } from "../genesis/vector.test-support.ts"
import { ACCOUNT, fixture } from "./testing/genesis-enable.test-support.ts"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

for (const change of ["replacement", "aba", "refresh"] as const) {
  test(`pin boundary serializes a sibling credential ${change} without notification`, async () => {
    const f = await fixture()
    cleanup.push(f.close)
    const verified = await walk(f.built.request, f.keyring)
    if (!verified.ok || verified.state.pin === null) throw new Error("fixture pin")
    const credentials = join(f.input.pinDir, "synthetic-credentials.json")
    writeFileSync(credentials, JSON.stringify({ identity: "A", generation: 1, token: 1 }))
    const locked = Promise.withResolvers<void>()
    const written = Promise.withResolvers<void>()
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "testing/credential-writer.test-support.ts"), credentials, change], {
      stdout: "inherit", stderr: "inherit",
      ipc(message) {
        if (message === "locked") locked.resolve()
        if (message === "written") written.resolve()
      },
    })
    cleanup.push(async () => { if (child.exitCode === null) child.send("write"); await child.exited })
    await Promise.race([locked.promise, child.exited.then(code => { throw new Error(`writer exited early: ${code}`) })])
    const entered = Promise.withResolvers<void>()
    const controller = new AbortController()
    let boundaries = 0
    const authority = {
      signal: controller.signal,
      admit<T>(effect: () => T): T { controller.signal.throwIfAborted(); return effect() },
      async boundary<T>(dispatch: () => T): Promise<T> {
        boundaries++
        entered.resolve()
        return withLock(`${credentials}.lock`, await createLockRecord("credential-test-pin"), async () => {
          const state = JSON.parse(readFileSync(credentials, "utf8")) as { generation: number }
          if (state.generation !== 1) throw new DOMException("Generation retired", "AbortError")
          return dispatch()
        })
      },
    }
    let renames = 0
    const original = fs.renameSync
    const spy = spyOn(fs, "renameSync").mockImplementation((from, to) => { renames++; original(from, to) })
    cleanup.push(() => spy.mockRestore())
    const result = pinTrustAnchor(f.input.pinDir, ACCOUNT, verified.state.pin, { authority })
    const first = await Promise.race([entered.promise.then(() => "boundary"), result.then(() => "published")])
    child.send("write")
    await written.promise
    expect(first).toBe("boundary")
    if (first !== "boundary") return
    if (change === "refresh") await result
    else await expect(result).rejects.toMatchObject({ name: "AbortError" })
    expect(controller.signal.aborted).toBe(false)
    expect(boundaries).toBe(1)
    expect(renames).toBe(change === "refresh" ? 1 : 0)
    expect(await child.exited).toBe(0)
  }, 15_000)
}
