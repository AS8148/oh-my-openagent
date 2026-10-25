import { afterEach, expect, test } from "bun:test"
import { _flushForTesting } from "../../../omo-opencode/src/shared/logger"
import { adaptRpcHandle } from "../manager/child-handle"
import { fakeClock } from "./rpc/__fixtures__/clock"
import { silentChild } from "./rpc/__fixtures__/silent-child"
import { createRpcChildHandle } from "./rpc/handle"
import { RpcProtocolClient } from "./rpc/protocol-client"
import { createHostSessionHandle } from "./rpc-host/handle"
import { event, fakeSessionPort, FAKE_SESSION } from "./rpc-host/handle.test-support"

let clock: ReturnType<typeof fakeClock>
afterEach(() => clock?.restore())

for (const kind of ["stdio", "host"] as const) {
  test(`${kind}: live child events reset missed probes without declaring unresponsive`, async () => {
    // Given one unanswered state request while the child continues doing work.
    clock = fakeClock()
    const fake = silentChild()
    const port = fakeSessionPort()
    const handle = kind === "host"
      ? createHostSessionHandle({
          client: port, session: FAKE_SESSION, taskId: "st_active", heartbeatIntervalMs: 10_000,
          now: clock.now, closeGraceMs: 100, openDisposition: "attached",
        })
      : createRpcChildHandle({
          client: new RpcProtocolClient({ child: fake.child }), child: fake.child,
          taskId: "st_active", heartbeatIntervalMs: 10_000, now: clock.now,
          terminateChild: async () => { fake.child.emit("close", null, "SIGKILL") },
        })
    const managed = adaptRpcHandle(handle)
    const statuses: string[] = []
    managed.onLiveness?.(status => { statuses.push(status.state) })
    // When events keep arriving for well beyond three missed state-probe windows.
    for (let i = 0; i < 12; i++) {
      await clock.advance(9_000)
      if (kind === "host") port.emitEvent(event({ type: "turn_start" }))
      else fake.emit({ type: "turn_start" })
    }
    // Then a slow control reply is congestion, not evidence that the child stopped.
    expect(handle.hasExited?.()).toBe(false)
    expect(statuses).toEqual([])
    if (kind === "host") expect(managed.liveness?.()).toEqual({ state: "running" })
    // Silence after the last event still reaches the normal missed-probe threshold.
    await clock.advance(40_000)
    if (kind === "stdio") expect(handle.hasExited?.()).toBe(true)
    else expect(managed.liveness?.().state).toBe("unresponsive")
    await handle.dispose()
    _flushForTesting()
    expect(clock.pending()).toBe(0)
  })
}
