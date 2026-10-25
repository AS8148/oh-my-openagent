import { expect, test } from "bun:test"
import { buildRpcSpawn } from "./spawn"

const spec = {
  task_id: "worker-task",
  cwd: "/synthetic/work",
  state_dir: "/synthetic/state",
  prompt: "work",
  parent_session_id: "nested-parent",
  root_session_id: "tree-root",
}

test.each([null, "/synthetic/senpi"])("standalone ancestry is capability gated for launcher %s", (executable) => {
  // given either the executable path or the rpc-entry fallback
  const runtime = {
    isBunBinary: false, isCompiledEngine: false, execPath: "/synthetic/bun",
    parentEnv: {}, resolveRpcEntry: () => "/synthetic/rpc-entry.js",
    resolveSenpiExecutable: () => executable,
  }
  for (const supportsSpawnedBy of [false, true]) {
    // when the resolved engine capability is supplied to descriptor construction
    const descriptor = buildRpcSpawn(spec, { ...runtime, supportsSpawnedBy })
    const index = descriptor.args.indexOf("--spawned-by")
    // then old engines never receive an unknown flag, and supported ones receive the full triple
    expect(index >= 0).toBe(supportsSpawnedBy)
    if (supportsSpawnedBy) {
      const encoded = descriptor.args[index + 1]
      if (encoded === undefined) throw new Error("ancestry JSON missing")
      expect(JSON.parse(encoded)).toEqual({
        parentSessionId: "nested-parent", rootSessionId: "tree-root", taskId: "worker-task",
      })
    }
  }
})

test.each([null, "/synthetic/senpi"])("the current pinned engine receives ancestry by default for launcher %s", (executable) => {
  // given the default pinned-engine capability (no test override)
  // when a fresh process descriptor is constructed
  const descriptor = buildRpcSpawn(spec, {
    isBunBinary: false, isCompiledEngine: false, execPath: "/synthetic/bun",
    parentEnv: {}, resolveSenpiExecutable: () => executable, resolveRpcEntry: () => "/synthetic/rpc-entry.js",
  })
  // then the pinned engine receives the parent, root, and task identity without a capability override
  const index = descriptor.args.indexOf("--spawned-by")
  expect(index).toBeGreaterThanOrEqual(0)
  const encoded = descriptor.args[index + 1]
  if (encoded === undefined) throw new Error("ancestry JSON missing")
  expect(JSON.parse(encoded)).toEqual({
    parentSessionId: "nested-parent", rootSessionId: "tree-root", taskId: "worker-task",
  })
})
