import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js"
import { SkillMcpManager, type EnvGrant, type GrantStore } from "../../features/skill-mcp-manager"
import { setStdioClientDependenciesForTesting } from "../../features/skill-mcp-manager/stdio-client"
import { createSkillContext } from "../../plugin/skill-context"
import { createCommandExecuteBeforeHandler } from "../../plugin/command-execute-before"
import { OhMyOpenCodeConfigSchema } from "../../config"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { createSkillMcpTool } from "./tools"

const roots: string[] = []
const managers: SkillMcpManager[] = []
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.disconnectAll()
  setStdioClientDependenciesForTesting()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("host config reference grant survives manager restart and revoke restores the literal without leaking values", async () => {
  // given
  const root = mkdtempSync(join(tmpdir(), "legacy-host-grant-"))
  roots.push(root)
  const project = join(root, "project")
  const host = join(root, "opaque-host", "fixture")
  mkdirSync(join(project, ".git"), { recursive: true })
  mkdirSync(host, { recursive: true })
  writeFileSync(join(host, "SKILL.md"), `---
name: fixture
description: synthetic
mcp:
  synthetic:
    command: synthetic-command
    env:
      AUTH_HEADER: "\${GITHUB_TOKEN}"
---
Synthetic host skill.
`)
  const oldToken = process.env.GITHUB_TOKEN
  process.env.GITHUB_TOKEN = "synthetic-not-a-real-token"
  const transports: StdioServerParameters[] = []
  setStdioClientDependenciesForTesting({
    createTransport: (options) => {
      transports.push(options)
      return { start: async () => {}, send: async () => {}, close: async () => {} }
    },
    createClient: () => ({
      connect: async () => {}, close: async () => {},
      listTools: async () => ({ tools: [] }), listResources: async () => ({ resources: [] }),
      listPrompts: async () => ({ prompts: [] }), callTool: async () => ({ content: [] }),
      readResource: async () => ({ contents: [] }), getPrompt: async () => ({ messages: [] }),
    }),
  })
  const grants: Record<string, EnvGrant> = {}
  let generation = 0
  const listeners = new Set<() => void | Promise<void>>()
  const store: GrantStore = {
    read: async () => ({ version: 1, generation, grants: { ...grants } }),
    add: async (digest, grant) => {
      grants[digest] = grant
      generation++
      await Promise.all([...listeners].map((listener) => listener()))
    },
    revoke: async (digest) => {
      delete grants[digest]
      generation++
      await Promise.all([...listeners].map((listener) => listener()))
    },
    list: async () => ({ ...grants }),
    digest: async () => String(generation),
    watch: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const notices: string[] = []
  const manager = new SkillMcpManager({ grantStore: store, onEnvironmentNotice: (message) => notices.push(message) })
  managers.push(manager)
  try {
    const context = await createSkillContext({
      directory: project, pluginConfig: OhMyOpenCodeConfigSchema.parse({}),
      hostSkills: { paths: [join(root, "opaque-host")] },
    })
    const toolContext = unsafeTestValue({
      sessionID: "synthetic", directory: project, ask: async () => {},
    })
    const tool = createSkillMcpTool({ manager, getLoadedSkills: () => context.mergedSkills })
    const first = await tool.execute({ mcp_name: "synthetic", tool_name: "test" }, toolContext)
    const id = first.match(/\/omo-mcp-env-grant ([a-zA-Z0-9_-]+)/)?.[1]
    if (!id) throw new Error("No exact grant command in tool output")
    expect(transports.at(-1)?.env?.AUTH_HEADER).toBe("${GITHUB_TOKEN}")
    const handler = createCommandExecuteBeforeHandler(unsafeTestValue({
      directory: project, hooks: {}, mcpManager: manager,
    }))
    // when
    await handler({ command: "omo-mcp-env-grant", arguments: `${id} GITHUB_TOKEN`, sessionID: "synthetic" }, { parts: [] })
    await manager.disconnectAll()
    const restarted = new SkillMcpManager({ grantStore: store, onEnvironmentNotice: (message) => notices.push(message) })
    managers.push(restarted)
    const secondTool = createSkillMcpTool({ manager: restarted, getLoadedSkills: () => context.mergedSkills })
    await secondTool.execute({ mcp_name: "synthetic", tool_name: "test" }, toolContext)
    expect(transports.at(-1)?.env?.AUTH_HEADER).toBe("synthetic-not-a-real-token")
    const [digest] = Object.keys(grants)
    if (!digest) throw new Error("Grant did not persist in the shared store")
    await store.revoke(digest)
    await secondTool.execute({ mcp_name: "synthetic", tool_name: "test" }, toolContext)
    // then
    expect(transports.at(-1)?.env?.AUTH_HEADER).toBe("${GITHUB_TOKEN}")
    expect(JSON.stringify(await store.read())).not.toContain("synthetic-not-a-real-token")
    expect(notices.join("\n")).not.toContain("synthetic-not-a-real-token")
  } finally {
    if (oldToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = oldToken
  }
})
