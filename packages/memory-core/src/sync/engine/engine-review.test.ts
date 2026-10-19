import { afterEach, expect, test } from "bun:test"

import { CrashInjected } from "./engine"
import { type Device, GIT_TEST_TIMEOUT, makeDevice } from "./engine-harness.test-support"
import { FakeSyncServer } from "./fake-server.test-support"

// Regressions from the #10548 review: a remote create+delete must never wedge a device that never
// had the file (H1), and an edit made between an interrupted cycle and its resume must survive (M1).

const devices: Device[] = []
afterEach(async () => {
  for (const d of devices.splice(0)) await d.dispose()
}, GIT_TEST_TIMEOUT)

const crashAt = (point: string) => (at: string) => {
  if (at === point) throw new CrashInjected(point)
}

for (const realStore of [false, true]) {
  const store = realStore ? "Loro store" : "fake store"

  test(`${store}: a fresh device receiving a create and a delete of a file it never had keeps syncing`, async () => {
    const server = new FakeSyncServer()
    const a = await makeDevice(server, "a", undefined, { realStore })
    devices.push(a)
    await a.write("gone.md", "short-lived\n")
    await a.engine.runCycle()
    await a.write("gone.md", null)
    await a.engine.runCycle()
    await a.write("kept.md", "kept\n")
    await a.engine.runCycle()
    const b = await makeDevice(server, "b", undefined, { realStore })
    devices.push(b)
    await b.engine.runCycle()
    expect(await b.read("gone.md")).toBeNull()
    expect(await b.read("kept.md")).toBe("kept\n")
    expect((await b.engine.state()).cycle).toBeNull()
    expect((await b.engine.state()).applied).toBe(3)
    await b.write("from-b.md", "b\n")
    await b.engine.runCycle()
    await a.engine.runCycle()
    expect(await a.read("from-b.md")).toBe("b\n")
  }, GIT_TEST_TIMEOUT)

  test(`${store}: an edit made between a cycle interrupted at merged and its resume reaches both devices`, async () => {
    const server = new FakeSyncServer()
    const a = await makeDevice(server, "a", undefined, { realStore })
    const b = await makeDevice(server, "b", undefined, { realStore })
    devices.push(a, b)
    await a.write("x.md", "one\n")
    await a.engine.runCycle()
    await b.engine.runCycle()
    await a.write("x.md", "one\nfrom-a\n")
    await a.engine.runCycle()
    await b.restart(crashAt("merged"))
    await expect(b.engine.runCycle()).rejects.toBeInstanceOf(CrashInjected)
    await b.write("x.md", "one\nfrom-b-after-crash\n")
    await b.restart()
    await b.engine.runCycle()
    await a.engine.runCycle()
    await b.engine.runCycle()
    const [onA, onB] = [await a.read("x.md"), await b.read("x.md")]
    expect(onA).toBe(onB)
    for (const line of ["one", "from-a", "from-b-after-crash"]) expect(onB).toContain(line)
  }, GIT_TEST_TIMEOUT)
}
