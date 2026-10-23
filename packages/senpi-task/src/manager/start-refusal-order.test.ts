import type { ChildProcess } from "node:child_process"
import { expect, test } from "bun:test"

import { RpcProcessRunner } from "../runners/rpc-process"
import { spawnFakeChild } from "../runners/rpc/__fixtures__/spawn-fake"
import { baseSpec, cleanupProjects, makeManager } from "./__fixtures__/manager-fakes"
import { createRpcManagedRunner } from "./runner"

test("a delayed first-write refusal reports start_failed while teardown holds its live child (#10402, #11032)", async () => {
  const writing = Promise.withResolvers<(error: Error) => void>()
  const terminating = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const terminated = Promise.withResolvers<void>()
  let child: ChildProcess | undefined
  const rpcRunner = new RpcProcessRunner({
    modelAdmission: async () => {},
    buildSpawn: (spec) => ({ command: process.execPath, args: [], cwd: spec.cwd, env: process.env }),
    spawnChild: () => {
      const spawned = spawnFakeChild()
      child = spawned
      if (spawned.stdin === null) throw new Error("fake child stdin was not piped")
      Object.defineProperty(spawned.stdin, "write", {
        value: (_payload: string, callback: (error: Error) => void): boolean => {
          writing.resolve(callback)
          return false
        },
      })
      return spawned
    },
    terminateChild: async (spawned) => {
      terminating.resolve()
      await release.promise
      const exited = new Promise<void>((resolve) => spawned.once("exit", () => resolve()))
      spawned.kill("SIGTERM")
      await exited
      terminated.resolve()
    },
  })
  const { manager, store } = makeManager({ process: createRpcManagedRunner(rpcRunner) })
  try {
    const starting = manager.start(baseSpec({ execution_mode: "process" }))
    // The runner has passed model admission and reached its first write. The manager's
    // other startup awaits have finished; refusal is not delivered inside spawn/start.
    const rejectWrite = await Promise.race([
      writing.promise,
      starting.then((result) => { throw new Error(`start settled before its first write: ${result.kind}`) }),
    ])
    rejectWrite(new Error("synthetic delayed first prompt refusal"))
    await terminating.promise
    const result = await starting
    expect(child?.exitCode).toBeNull()
    expect(child?.signalCode).toBeNull()
    expect(result.kind).toBe("start_failed")
    if (result.kind !== "start_failed") throw new Error(`unexpected start result: ${result.kind}`)
    const record = store.load(result.task_id)
    expect(record?.status).toBe("error")
    expect(result.failure_kind).toBe("child-prompt-failed")
  } finally {
    release.resolve()
    if (child !== undefined) await terminated.promise
    // Both dev's awaited teardown and the fixed detached teardown must settle
    // before fixture directories are removed.
    await manager.settleLaunchesForShutdown?.(2_000)
    cleanupProjects()
  }
}, 10_000)
