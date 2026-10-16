import { afterEach, describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildIdentityPaths } from "@oh-my-opencode/memory-core"
import { createMemoryIdentityContext } from "./context"
import type { MemoryMaintenance } from "./memory-maintenance"
import { MemoryFakeExtensionAPI, componentContext, loadedMemoryConfig, memorySettings } from "./memory.test-support"
import { rmEfaultTolerant } from "./teardown.test-support"
import { createMemoryWiring } from "./wiring"

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rmEfaultTolerant(root, { recursive: true, force: true })
})

type Warning = { readonly message: string; readonly data?: Record<string, unknown> }

// Work that never settles: the only way shutdown can account for it is to race it against the drain budget.
const never = (): Promise<never> => new Promise<never>(() => {})

async function bindAndShutDown(overrides: { maintenance?: MemoryMaintenance }) {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "omo-memory-shutdown-settle-")))
  roots.push(root)
  const identityName = "shutdown-settle-agent"
  const identity = createMemoryIdentityContext({
    identity: identityName,
    identityPaths: buildIdentityPaths(root, identityName),
    binding: { identity: identityName, repoPathHash: "hash", boundAt: 1 },
  })
  const sessionId = "session-shutdown-settle"
  const warnings: Warning[] = []
  const logger = {
    debug: () => {},
    info: () => {},
    warn: (message: string, data?: Record<string, unknown>) => { warnings.push({ message, ...(data === undefined ? {} : { data }) }) },
    error: () => {},
  }
  const wiring = createMemoryWiring({
    sessions: new Map([[sessionId, { context: identity }]]),
    loadConfig: () => loadedMemoryConfig(memorySettings()),
    cwd: () => root,
    env: {},
    logger,
    ...(overrides.maintenance === undefined ? {} : { createMaintenance: () => overrides.maintenance! }),
  })
  const pi = new MemoryFakeExtensionAPI()
  wiring.registerStatic(pi, componentContext())
  const eventCtx = {
    sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
    ui: { setStatus: () => {}, notify: () => {} },
  }
  await wiring.afterBind(pi, sessionId, identity, eventCtx)
  // A zero budget: every raced step is reported as over budget instead of being awaited.
  await wiring.onSessionShutdown({ reason: "reload", sessionId, deadlineAt: Date.now() })
  return warnings
    .filter((warning) => warning.message === "memory shutdown drain hit its budget")
    .map((warning) => warning.data?.step)
}

describe("memory wiring shutdown settles maintenance running in the identity dir (#10154)", () => {
  test("#given a maintenance pass is still running #when the session shuts down #then shutdown races it against the drain budget", async () => {
    // given
    const maintenance: MemoryMaintenance = { schedule: () => {}, dispose: () => {}, settled: never }

    // when
    const overBudget = await bindAndShutDown({ maintenance })

    // then
    expect(overBudget).toContain("maintenance-settle")
  })
})
