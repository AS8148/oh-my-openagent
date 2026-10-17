import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DORI_STORE_EXTENSION } from "../../ulw-loop/sdk/dori-gate"
import { gatewayDatabasePath } from "../gateway/paths"
import { createGatewayStore, type GatewayStore } from "../gateway/store"
import type { SessionCallableOp } from "../gateway/store-extensions"
import type { ThreadHost, ThreadHostSession } from "../tools"
import { openDoriReplay, type DoriReplay } from "./dori-replay"
import { buildExtensionTools } from "./extension-tools"
import { UNKNOWN_CALLER, type ThreadToolSurfaceOptions } from "./ports"

const directories: string[] = []
const stores: GatewayStore[] = []
const replays: DoriReplay[] = []
afterEach(async () => {
  for (const replay of replays.splice(0)) replay.close()
  await Promise.all(stores.splice(0).map((store) => store.dispose()))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const fixture = new URL("../gateway/testing/dori-layer2-extension.mjs", import.meta.url)
const parameters = { type: "object", additionalProperties: false, properties: { note: { type: "string" }, replay_key: { type: "string" }, turn_id: { type: "string" } } }
const ops: SessionCallableOp[] = [
  { op: "replyMark", toolName: "reply_mark", description: "Mark a reply debt.", parameters },
  { op: "sendPost", toolName: "send_post", description: "Post to a room.", parameters },
]
const caller: ThreadHostSession = { sessionId: "route-caller", durableSessionId: "dur-caller", cwd: process.cwd(), name: "caller", status: "open" }
const recent = new Date().toISOString()
const branch: unknown[] = [
  { type: "message", id: "u1", timestamp: recent, message: { role: "user" } },
  { type: "message", id: "a1", timestamp: recent, message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "ext_dori_reply_mark" }, { type: "toolCall", id: "cell-a", name: "eval" }] } },
]
const ectx = { sessionManager: { getSessionId: () => "dur-caller", getBranch: () => branch } }

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

function host(): ThreadHost {
  const unused = async () => { throw new Error("not used") }
  return {
    socket: "/tmp/extension-tools-dori.sock",
    listSessions: async () => [caller],
    openSession: async () => caller,
    getMessages: async () => [],
    getState: async () => ({ isStreaming: false }),
    prompt: unused, interrupt: unused, setSessionName: unused, setModel: unused,
    getAvailableModels: async () => [], setThinkingLevel: unused, getAvailableThinkingLevels: async () => [],
  } as ThreadHost
}

async function setup(extension = DORI_STORE_EXTENSION, sessionCallable: readonly SessionCallableOp[] = ops) {
  const agentDir = tempDir("extension-tools-dori-")
  const store = createGatewayStore({ agentDir })
  stores.push(store)
  const migrations = extension === DORI_STORE_EXTENSION ? [["CREATE TABLE dori_calls (id INTEGER PRIMARY KEY, op TEXT NOT NULL, args TEXT NOT NULL)"]] : []
  expect(await store.registerStoreExtension({ name: extension, moduleUrl: fixture.href, migrations, sessionCallable })).toMatchObject({ kind: "ok" })
  const journal = join(agentDir, "toolkit-replay.sqlite")
  const base: ThreadToolSurfaceOptions = { host: host(), store, stateDirectory: tempDir("extension-tools-dori-state-"), callerSessionId: () => UNKNOWN_CALLER, callerWorkspaceRoot: () => process.cwd() }
  const freshProcess = async (): Promise<ThreadToolSurfaceOptions> => {
    const replay = await openDoriReplay({ path: journal })
    replays.push(replay)
    return { ...base, doriReplay: async () => replay }
  }
  return { agentDir, base, freshProcess, journal }
}

async function call(options: ThreadToolSurfaceOptions, name: string, args: Record<string, unknown> = { note: "n" }, toolCallId = "call-1") {
  const tool = (await buildExtensionTools(options)).find((candidate) => candidate.name === name)
  if (tool === undefined) throw new Error(`no tool ${name}`)
  const output = await tool.execute(toolCallId, args, undefined, undefined, ectx as never) as { details: { result: Record<string, unknown> } }
  return output.details.result
}

function storeRows(agentDir: string): { op: string; args: string }[] {
  const db = new Database(gatewayDatabasePath(agentDir))
  try {
    const table = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%dori_calls'").get() as { name: string } | null
    return table === null ? [] : db.query(`SELECT op, args FROM "${table.name}" ORDER BY id`).all() as { op: string; args: string }[]
  } finally {
    db.close()
  }
}

function journalKeys(journal: string): string[] {
  const db = new Database(journal)
  try {
    return (db.query("SELECT replay_key FROM toolkit_replay ORDER BY replay_key").all() as { replay_key: string }[]).map((row) => row.replay_key)
  } finally {
    db.close()
  }
}

test("#given the dori toolkit is on #when a fresh process replays the same turn's reply.mark #then the recorded result returns and the host dispatched once", async () => {
  const { agentDir, freshProcess } = await setup()
  const first = await call(await freshProcess(), "ext_dori_reply_mark")
  expect(first).toMatchObject({ kind: "ok", value: { op: "reply.mark", dispatch_number: 1, caller: "dur-caller" } })
  expect(await call(await freshProcess(), "ext_dori_reply_mark")).toEqual(first)
  expect(storeRows(agentDir)).toHaveLength(1)
})

test("#given the turn recorded reply.mark at index 0 #when a replay calls send.post there #then it stops with the op divergence and nothing dispatches", async () => {
  const { agentDir, freshProcess } = await setup()
  await call(await freshProcess(), "ext_dori_reply_mark")
  expect(await call(await freshProcess(), "ext_dori_send_post")).toMatchObject({ kind: "replay_stopped", code: "toolkit_replay_divergence", differs: ["op"], recorded_op: "reply.mark", attempted_op: "send.post", key: '["turn","dur-caller:a1/call-1",0]' })
  expect(storeRows(agentDir)).toHaveLength(1)
})

test("#given a recorded call #when a replay sends the same op with different arguments #then it stops with the arguments divergence and nothing dispatches", async () => {
  const { agentDir, freshProcess } = await setup()
  await call(await freshProcess(), "ext_dori_reply_mark", { note: "hello" })
  expect(await call(await freshProcess(), "ext_dori_reply_mark", { note: "DIFFERENT" })).toMatchObject({ kind: "replay_stopped", code: "toolkit_replay_divergence", differs: ["args"] })
  expect(storeRows(agentDir)).toHaveLength(1)
})

test("#given a kernel cell that outlived its turn #when its call replays after the session moved on #then it keeps its original turn and returns the recorded result", async () => {
  const { agentDir, freshProcess } = await setup()
  const carried = { note: "n", omo_toolkit_replay: { cell: "cell-a", index: 0 } }
  const first = await call(await freshProcess(), "ext_dori_reply_mark", carried, "kernel-generated")
  branch.push({ type: "message", id: "a2", timestamp: recent, message: { role: "assistant", content: [{ type: "toolCall", id: "cell-b", name: "eval" }] } })
  try {
    expect(await call(await freshProcess(), "ext_dori_reply_mark", carried, "kernel-generated")).toEqual(first)
  } finally {
    branch.pop()
  }
  expect(storeRows(agentDir)).toHaveLength(1)
  expect(JSON.parse(storeRows(agentDir)[0]?.args ?? "{}")).toEqual({ note: "n", caller_session_durable_id: "dur-caller" })
})

test("#given key-shaped arguments or a carried turn the engine did not issue #when called #then the arguments never pick the journal key and a foreign turn is refused before dispatch", async () => {
  const { agentDir, freshProcess, journal } = await setup()
  const options = await freshProcess()
  expect(await call(options, "ext_dori_reply_mark", { note: "n", replay_key: '["turn","evil",0]', turn_id: "evil" })).toMatchObject({ kind: "ok" })
  expect(journalKeys(journal)).toEqual(['["turn","dur-caller:a1/call-1",0]'])
  expect(await call(options, "ext_dori_send_post", { note: "n", omo_toolkit_replay: { cell: "cell-of-another-session", index: 0 } }, "kernel-generated")).toMatchObject({ kind: "replay_stopped", code: "toolkit_replay_turn_unknown" })
  expect(storeRows(agentDir)).toHaveLength(1)
})

test("#given the toolkit on and off #when the layer-2 tools are built #then only on does the tool schema accept the SDK's replay context, so the engine's argument validation lets the kernel's calls through", async () => {
  const { base, freshProcess } = await setup()
  const propertiesOf = async (options: ThreadToolSurfaceOptions) => ((await buildExtensionTools(options)).find((tool) => tool.name === "ext_dori_reply_mark")?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}
  expect(Object.keys(await propertiesOf(await freshProcess()))).toEqual(["note", "replay_key", "turn_id", "omo_toolkit_replay"])
  expect(Object.keys(await propertiesOf(base))).toEqual(["note", "replay_key", "turn_id"])
})

test("#given the dori toolkit is off #when the same op is called twice #then no replay journal applies and each call dispatches", async () => {
  const { agentDir, base } = await setup()
  await call(base, "ext_dori_reply_mark")
  await call(base, "ext_dori_reply_mark")
  expect(storeRows(agentDir)).toHaveLength(2)
})

test("#given the toolkit is on #when another extension declares namespace-shaped tools #then they are not journaled", async () => {
  const ping: SessionCallableOp = { op: "ping", toolName: "reply_mark", description: "Shaped like a layer-2 tool.", parameters: { type: "object", additionalProperties: false, properties: { note: { type: "string" } } } }
  const { freshProcess, journal } = await setup("other", [ping])
  const options = await freshProcess()
  expect(await call(options, "ext_other_reply_mark")).toEqual({ kind: "ok", value: { pinged: true } })
  expect(await call(options, "ext_other_reply_mark")).toEqual({ kind: "ok", value: { pinged: true } })
  expect(journalKeys(journal)).toEqual([])
})
