import { expect, test } from "bun:test"
import { once } from "node:events"
import { refusalChild, refusalRecord } from "../../../../senpi-desktop-engine/test/refusal-child"
import { fakeEngineFactory, rejectionOf } from "../../../../senpi-desktop-service/test/harness"
import { probeComputerUseEngine } from "./engine-probe"
import { TrackedDesktopService } from "./engine-status"

for (const reason of ["self-responsible", "unresolved"]) {
  test(`doctor reports actual ${reason} refusal`, async () => {
    const result = await probeComputerUseEngine("/fixture", {}, 5_000,
      () => refusalChild({ stderr: refusalRecord(reason) }))
    expect(result).toMatchObject({ ok: false, code: "launch-context-unavailable", reason })
  }, 10_000)
}

test("status stays passive, records failed restart, and emits no permission event", async () => {
  const live = fakeEngineFactory()
  const permissions: unknown[] = []
  let launches = 0
  const service = new TrackedDesktopService({
    createChild: () => ++launches === 1 ? live.spawn() : refusalChild(),
    onPermissionRequired: (permission) => permissions.push(permission),
  })
  expect(service.engineState).toBe("not started")
  expect(launches).toBe(0)
  await service.open({})
  expect(service.engineState).toBe("ready")
  const child = live.children[0]
  if (!child) throw new Error("missing child")
  const closed = once(child, "close")
  child.kill()
  await closed
  expect(await rejectionOf(service.capabilities())).toMatchObject({ code: "launch-context-unavailable" })
  expect(service.engineState).toBe("launch-context-unavailable")
  expect(launches).toBe(2)
  expect(permissions).toEqual([])
  await service.close()
}, 10_000)

test("initial tracked activation preserves the typed reason", async () => {
  const service = new TrackedDesktopService({ createChild: () => refusalChild() })
  expect(await rejectionOf(service.open({}))).toMatchObject({
    code: "launch-context-unavailable", reason: "self-responsible",
  })
  expect(service.engineState).toBe("launch-context-unavailable")
  await service.close()
}, 10_000)
