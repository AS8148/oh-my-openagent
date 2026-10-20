import { afterEach, expect, mock, test } from "bun:test"
import { SkillMcpManager } from "./manager"
import { setStdioClientDependenciesForTesting } from "./stdio-client"
import type { McpClient } from "./types"

type Grant = { digest: string; label: string; names: string[] }
function latestStore() {
  let generation = 0
  let revision = "initial-file"
  let grants: Grant[] = []
  const listeners = new Set<() => void | Promise<void>>()
  const notify = async () => { await Promise.all([...listeners].map((listener) => listener())) }
  return {
    read: async () => ({ generation, revision, grants }),
    list: async () => grants,
    digest: async () => `${revision}:${generation}`,
    add: async (grant: Grant) => { grants = [grant]; generation++; await notify() },
    revoke: async () => { grants = []; generation++; await notify() },
    watch: (listener: () => void | Promise<void>) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    revokeThenRegrant: async () => { generation += 2; await notify() },
    recreate: async () => { revision = "replacement-file"; generation = 0; await notify() },
  }
}
const managers: SkillMcpManager[] = []
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.disconnectAll()
  setStdioClientDependenciesForTesting()
})

test.each(["gap", "recreation"])("latest-state observer invalidates live project connections on %s even when grants match", async (change) => {
  // given
  const closes: ReturnType<typeof mock>[] = []
  setStdioClientDependenciesForTesting({
    createClient: (): McpClient => {
      const close = mock(async () => {})
      closes.push(close)
      return {
        connect: async () => {}, close,
        listTools: async () => ({ tools: [] }), listResources: async () => ({ resources: [] }),
        listPrompts: async () => ({ prompts: [] }), callTool: async () => ({ content: [] }),
        readResource: async () => ({ contents: [] }), getPrompt: async () => ({ messages: [] }),
      }
    },
    createTransport: () => ({ start: async () => {}, send: async () => {}, close: async () => {} }),
  })
  const store = latestStore()
  const notices: string[] = []
  const manager = new SkillMcpManager(Object.assign({}, {
    grantStore: store, onEnvironmentNotice: (message: string) => notices.push(message),
  }))
  managers.push(manager)
  const info = {
    sessionID: "observer-project", skillName: "fixture", serverName: "fixture", scope: "project",
    sourcePath: "/synthetic/project/SKILL.md", directory: "/synthetic/project",
  }
  const config = { command: "synthetic", env: { AUTH_HEADER: "${GITHUB_TOKEN}" } }
  await manager.getOrCreateClient(info, config)
  const id = notices[0]?.match(/\/omo-mcp-env-grant ([a-zA-Z0-9_-]+)/)?.[1]
  if (!id) throw new Error("No pending grant action")
  await manager.grantEnvironment(id, ["GITHUB_TOKEN"])
  await manager.getOrCreateClient(info, config)
  const live = closes.at(-1)
  if (!live) throw new Error("No live project client")
  // when
  if (change === "gap") await store.revokeThenRegrant()
  else await store.recreate()
  // then
  expect(live).toHaveBeenCalledTimes(1)
})
