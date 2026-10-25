import { describe, expect, jest, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import { createProtocolTransport } from "./protocol-transport"
import { setMcpClientLoggerForTesting } from "../logger"

const version = "2026-07-28"
const identity = { name: "skill-mcp-test", version: "1.0.0" }

async function fixture(mode: "modern" | "legacy" | "unsupported" | "input" | "operation-unsupported" | "unknown" | "fallback-error" | "fallback-version") {
  const sent: JSONRPCMessage[] = []
  const transport: Transport = {
    async start() {},
    async close() { transport.onclose?.() },
    async send(message) {
      sent.push(message)
      if (!("method" in message) || !("id" in message)) return
      let response: JSONRPCMessage
      if (message.method === "server/discover") {
        response = mode === "legacy" || mode === "unsupported"
          ? { jsonrpc: "2.0", id: message.id, error: { code: mode === "legacy" ? -32601 : -32022, message: "unsupported" } }
          : { jsonrpc: "2.0", id: message.id, result: {
            resultType: "complete", supportedVersions: [version],
            capabilities: mode === "operation-unsupported" ? { tools: {} } : { tools: {}, resources: {}, prompts: {} },
          } }
      } else if (message.method === "initialize" && mode === "fallback-error") {
        response = { jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "legacy initialization failed" } }
      } else if (message.method === "initialize") {
        response = { jsonrpc: "2.0", id: message.id, result: {
          protocolVersion: mode === "fallback-version" ? "unsupported-version" : "2025-03-26",
          capabilities: mode === "operation-unsupported" ? { tools: {}, resources: {} } : { tools: {} },
          serverInfo: { name: "legacy", version: "1" },
        } }
      } else if (["operation-unsupported", "fallback-error", "fallback-version"].includes(mode) && message.params?._meta) {
        response = { jsonrpc: "2.0", id: message.id, error: { code: -32022, message: "unsupported" } }
      } else if (mode === "input" || mode === "unknown") {
        response = { jsonrpc: "2.0", id: message.id, result: {
          resultType: mode === "input" ? "input_required" : "extension-result", inputRequests: {}, requestState: "opaque",
        } }
      } else {
        const payload = message.method === "tools/list" ? { tools: [] }
          : message.method === "resources/list" ? { resources: [] }
          : message.method === "prompts/list" ? { prompts: [] }
          : message.method === "resources/read" ? { contents: [] }
          : message.method === "prompts/get" ? { messages: [] }
          : { content: [{ type: "text", text: "done" }] }
        response = { jsonrpc: "2.0", id: message.id, result: { resultType: "complete", ...payload } }
      }
      queueMicrotask(() => transport.onmessage?.(response))
    },
  }
  const client = new Client(identity, { capabilities: {}, enforceStrictCapabilities: true })
  await client.connect(createProtocolTransport(transport, client))
  return { client, sent }
}

describe("skill MCP protocol eras", () => {
  test("modern discovery replaces the wire handshake and every operation carries metadata", async () => {
    const { client, sent } = await fixture("modern")
    try {
      await client.listTools()
      await client.listResources()
      await client.listPrompts()
      await client.readResource({ uri: "file:///example" })
      await client.getPrompt({ name: "example" })
      expect(await client.callTool({ name: "example", arguments: {}, _meta: { "example/trace": "kept" } })).toMatchObject({
        content: [{ type: "text", text: "done" }],
      })
      expect(sent.filter((message) => "method" in message).map((message) => message.method)).toEqual([
        "server/discover", "tools/list", "resources/list", "prompts/list", "resources/read", "prompts/get", "tools/call",
      ])
      for (const message of sent) {
        if (!("method" in message)) continue
        expect(message.params?._meta).toMatchObject({
          "io.modelcontextprotocol/protocolVersion": version,
          "io.modelcontextprotocol/clientInfo": identity,
          "io.modelcontextprotocol/clientCapabilities": {},
        })
      }
      const last = sent.at(-1)
      expect(last && "method" in last ? last.params?._meta?.["example/trace"] : undefined).toBe("kept")
    } finally { await client.close() }
  })

  for (const mode of ["legacy", "unsupported"] as const) {
    test(`${mode} discovery uses unchanged SDK initialization`, async () => {
      const { client, sent } = await fixture(mode)
      try {
        await client.listTools()
        const requests = sent.filter((message) => "method" in message)
        expect(requests.map((message) => message.method)).toEqual([
          "server/discover", "initialize", "notifications/initialized", "tools/list",
        ])
        expect(requests[1]?.params).toEqual({
          protocolVersion: "2025-11-25", clientInfo: identity, capabilities: {},
        })
        expect(requests[3]?.params?._meta).toBeUndefined()
        expect(client.getServerCapabilities()).toEqual({ tools: {} })
      } finally { await client.close() }
    })
  }

  test("input_required terminates without fabricating an input response", async () => {
    const { client, sent } = await fixture("input")
    try {
      await expect(client.callTool({ name: "example" })).rejects.toThrow("Skill MCP does not support elicitation")
      expect(sent).toHaveLength(2)
    } finally { await client.close() }
  })

  test("operation UnsupportedProtocolVersion initializes once and retries legacy", async () => {
    const { client, sent } = await fixture("operation-unsupported")
    try {
      await client.listTools()
      expect(sent.filter((message) => "method" in message).map((message) => message.method)).toEqual([
        "server/discover", "tools/list", "initialize", "notifications/initialized", "tools/list",
      ])
      expect(client.getServerCapabilities()).toEqual({ tools: {}, resources: {} })
      expect(client.getServerVersion()).toEqual({ name: "legacy", version: "1" })
      expect(await client.readResource({ uri: "file:///legacy-only" })).toMatchObject({ contents: [] })
    } finally { await client.close() }
  })

  for (const mode of ["fallback-error", "fallback-version"] as const) {
    test(`${mode} fails later requests without repeating legacy initialization`, async () => {
      const { client, sent } = await fixture(mode)
      try {
        const error = mode === "fallback-error" ? "legacy initialization failed" : "protocol version is not supported"
        await expect(client.listTools()).rejects.toThrow(error)
        await expect(client.listTools()).rejects.toThrow(error)
        expect(sent.filter((message) => "method" in message && message.method === "initialize")).toHaveLength(1)
      } finally { await client.close() }
    })
  }

  for (const mode of ["silent-legacy", "slow-modern"] as const) {
    test(`${mode} respects the shared discovery budget`, async () => {
      jest.useFakeTimers()
      const logs: { message: string; data: unknown }[] = []
      setMcpClientLoggerForTesting((message, data) => { logs.push({ message, data }) })
      const probed = Promise.withResolvers<string | number>()
      const methods: string[] = []
      const transport: Transport = {
        async start() {},
        async close() { transport.onclose?.() },
        async send(message) {
          if (!("method" in message)) return
          methods.push(message.method)
          if (!("id" in message)) return
          if (message.method === "server/discover") probed.resolve(message.id)
          if (message.method === "initialize") {
            queueMicrotask(() => transport.onmessage?.({ jsonrpc: "2.0", id: message.id, result: {
              protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "legacy", version: "1" },
            } }))
          }
        },
      }
      const client = new Client(identity, { capabilities: {} })
      try {
        const connected = client.connect(createProtocolTransport(transport, client))
        const discoveryID = await probed.promise
        const budget = DEFAULT_REQUEST_TIMEOUT_MSEC / 2
        jest.advanceTimersByTime(budget - 1)
        expect(methods).toEqual(["server/discover"])
        if (mode === "silent-legacy") {
          jest.advanceTimersByTime(1)
          await connected
          expect(methods).toEqual(["server/discover", "initialize", "notifications/initialized"])
          expect(logs).toHaveLength(1)
          expect(logs[0]?.data).toEqual({ timeoutMs: budget })
          expect(client.getServerVersion()?.name).toBe("legacy")
        } else {
          transport.onmessage?.({ jsonrpc: "2.0", id: discoveryID, result: {
            supportedVersions: [version], capabilities: { tools: {} },
            _meta: { "io.modelcontextprotocol/serverInfo": { name: "slow-modern", version: "1" } },
          } })
          await connected
          jest.advanceTimersByTime(budget + 1)
          expect(methods).toEqual(["server/discover"])
          expect(logs).toHaveLength(0)
          expect(client.getServerVersion()?.name).toBe("slow-modern")
        }
      } finally {
        await client.close()
        setMcpClientLoggerForTesting()
        jest.useRealTimers()
      }
    })
  }

  test("unknown result types fail instead of becoming empty success", async () => {
    const { client } = await fixture("unknown")
    try {
      await expect(client.callTool({ name: "example" })).rejects.toThrow("unsupported resultType: extension-result")
    } finally { await client.close() }
  })
})
