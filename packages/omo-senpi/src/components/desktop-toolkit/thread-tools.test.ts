/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import type { ComponentContext, SenpiExtensionAPI } from "../../extension/types"
import { createDesktopToolkitComponent, TOOLKIT_GRANT_RPC, TOOLKIT_REQUEST_EVENT } from "./index"

const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"] }
const content = [{ type: "text", text: "organized" }]
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function session(id: string) {
  return { sessionManager: { getSessionId: () => id } }
}

function setup(options: {
  offer?: string
  reply?: (request: Record<string, unknown>) => Record<string, unknown> | undefined
  timeoutMs?: number
  withRpc?: boolean
  withRegisterTool?: boolean
  component?: ReturnType<typeof createDesktopToolkitComponent>
} = {}) {
  const pi = new FakeExtensionAPI()
  Object.defineProperty(pi, "sessionContext", { value: { omo_toolkits: options.offer ?? "thread" } })
  const handlers = new Map<string, (data: unknown) => unknown>()
  const logs: unknown[] = []
  const log = (message: string, details?: unknown) => logs.push({ message, details })
  const ctx: ComponentContext = { logger: { debug: log, info: log, warn: log, error: log }, config: { getFlag: () => undefined } }
  const rpc: NonNullable<SenpiExtensionAPI["rpc"]> = {
    emit(name, data) {
      pi.rpcEvents.push({ name, data })
      if (typeof data !== "object" || data === null || !("requestId" in data)) return
      const response = options.reply?.(data)
      if (response !== undefined) handlers.get(TOOLKIT_GRANT_RPC)?.({ requestId: data.requestId, ...response })
    },
    handle(name, handler) { handlers.set(name, handler) },
  }
  if (options.withRpc !== false) pi.rpc = rpc
  if (options.withRegisterTool === false) Object.defineProperty(pi, "registerTool", { value: undefined })
  const component = options.component ?? createDesktopToolkitComponent({ timeoutMs: options.timeoutMs ?? 1_000 })
  component.register(pi, ctx)
  return {
    pi, logs, handlers,
    start: (id = "A") => pi.dispatch("session_start", { type: "session_start" }, session(id)),
    tools: () => pi.tools.filter((tool) => String(tool.name).startsWith("desktop_")),
  }
}

async function mcp(options: { listFailure?: boolean; callFailure?: boolean; echoToken?: boolean; sse?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "desktop-thread-"))
  const tokenFile = join(dir, "bearer")
  let token = `test-credential-${crypto.randomUUID()}`
  await writeFile(tokenFile, token, { mode: 0o600 })
  const requests: { method: unknown; params: unknown; authorized: boolean }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const authorized = request.headers.get("authorization") === `Bearer ${token}`
      if (!authorized) return new Response("unauthorized", { status: 401 })
      if (request.method !== "POST") return new Response(null, { status: 405 })
      const body = await request.json()
      if (typeof body !== "object" || body === null || !("method" in body)) return new Response(null, { status: 400 })
      const id = "id" in body ? body.id : undefined
      const params = "params" in body ? body.params : undefined
      requests.push({ method: body.method, params, authorized })
      if (id === undefined) return new Response(null, { status: 202 })
      let result: unknown
      if (body.method === "initialize") {
        result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "test-desktop", version: "1" } }
      } else if (body.method === "tools/list") {
        if (options.listFailure) return new Response(token, { status: 500 })
        result = { tools: [{ name: "thread_organize", description: "Organize this desktop thread.", inputSchema: schema }] }
      } else if (body.method === "tools/call") {
        if (options.callFailure) return Response.json({ jsonrpc: "2.0", id, error: { code: -32603, message: token } })
        result = { content: options.echoToken ? [{ type: "text", text: token }] : content }
      } else {
        return new Response(null, { status: 400 })
      }
      const response = { jsonrpc: "2.0", id, result }
      return options.sse
        ? new Response(`event: message\ndata: ${JSON.stringify(response)}\n\n`, { headers: { "content-type": "text/event-stream" } })
        : Response.json(response)
    },
  })
  cleanups.push(async () => { await server.stop(true); await rm(dir, { recursive: true, force: true }) })
  return {
    grant: { endpoint: `http://127.0.0.1:${server.port}/mcp`, tokenFile },
    requests, token: () => token,
    async rotate() { token = `rotated-${crypto.randomUUID()}`; await writeFile(tokenFile, token, { mode: 0o600 }) },
  }
}

async function execute(tool: Record<string, unknown> | undefined, id = "A") {
  if (typeof tool?.execute !== "function") throw new Error("desktop tool was not registered")
  return tool.execute("call-1", { title: "Grouped" }, undefined, undefined, session(id))
}

describe("desktop thread toolkit", () => {
  it("#given no thread offer #when session starts #then no request or desktop tool", async () => {
    const host = setup({ offer: "browser" })
    await host.start()
    expect(host.tools()).toEqual([])
    expect(host.pi.rpcEvents).toEqual([])
  })

  for (const sse of [false, true]) {
    it(`#given a grant and ${sse ? "SSE" : "JSON"} MCP #when starting and calling #then schema bearer arguments and content are forwarded`, async () => {
      const stub = await mcp({ sse })
      const host = setup({ reply: () => ({ grant: stub.grant }) })
      await host.start()
      await host.start()
      expect(host.pi.rpcEvents).toHaveLength(1)
      expect(host.pi.rpcEvents[0]).toMatchObject({ name: TOOLKIT_REQUEST_EVENT, data: { toolkit: "thread" } })
      expect(host.tools()).toHaveLength(1)
      const tool = host.tools()[0]
      expect(tool).toMatchObject({ name: "desktop_thread_organize", parameters: schema, description: "Organize this desktop thread." })
      expect(host.pi.tools.some((entry) => entry.name === "thread_organize")).toBe(false)
      await stub.rotate()
      const result = await execute(tool)
      expect(result.content).toEqual(content)
      expect(stub.requests.filter((request) => request.method === "tools/call")).toEqual([
        { method: "tools/call", params: { name: "thread_organize", arguments: { title: "Grouped" } }, authorized: true },
      ])
      expect(JSON.stringify([host.logs, result])).not.toContain(stub.token())
    })
  }

  it("#given refusal #when starting #then no tools and a nonsecret diagnostic", async () => {
    const secret = "refusal-must-not-be-logged"
    const host = setup({ reply: () => ({ refusal: { reason: secret } }) })
    await host.start()
    expect(host.pi.rpcEvents).toHaveLength(1)
    expect(host.tools()).toEqual([])
    expect(host.logs.length).toBeGreaterThan(0)
    expect(JSON.stringify(host.logs)).not.toContain(secret)
  })

  it("#given no grant reply #when the acquisition deadline expires #then no tools and late grant rejected", async () => {
    const host = setup({ timeoutMs: 10 })
    await host.start()
    expect(host.pi.rpcEvents).toHaveLength(1)
    const data = host.pi.rpcEvents[0]?.data
    if (typeof data !== "object" || data === null || !("requestId" in data)) throw new Error("request missing")
    expect(host.handlers.get(TOOLKIT_GRANT_RPC)?.({ requestId: data.requestId, grant: { endpoint: "http://127.0.0.1:1/mcp", tokenFile: "/unused" } })).toEqual({ accepted: false })
    expect(host.tools()).toEqual([])
    expect(host.logs.length).toBeGreaterThan(0)
  })

  it("#given tools/list failure containing a bearer #when starting #then no registrations or credential disclosure", async () => {
    const stub = await mcp({ listFailure: true })
    const host = setup({ reply: () => ({ grant: stub.grant }) })
    await host.start()
    expect(stub.requests.some((request) => request.method === "tools/list")).toBe(true)
    expect(host.tools()).toEqual([])
    expect(host.logs.length).toBeGreaterThan(0)
    expect(JSON.stringify(host.logs)).not.toContain(stub.token())
  })

  it("#given two registrations from one module #when A's executor is called in B #then B cannot spend A's grant", async () => {
    const stub = await mcp()
    const component = createDesktopToolkitComponent()
    const a = setup({ component, reply: () => ({ grant: stub.grant }) })
    const b = setup({ component, offer: "browser" })
    await a.start("A")
    await b.start("B")
    expect(b.tools()).toEqual([])
    expect(b.pi.rpcEvents).toEqual([])
    const before = stub.requests.length
    const result = await execute(a.tools()[0], "B")
    expect(result.isError).toBe(true)
    expect(stub.requests).toHaveLength(before)
    expect(JSON.stringify([result, a.logs, b.logs])).not.toContain(stub.token())
    expect((await execute(a.tools()[0], "A")).content).toEqual(content)
  })

  it("#given no calling session identity #when an executor is called #then it refuses without an HTTP request", async () => {
    const stub = await mcp()
    const host = setup({ reply: () => ({ grant: stub.grant }) })
    await host.start()
    const tool = host.tools()[0]
    if (typeof tool?.execute !== "function") throw new Error("desktop tool was not registered")
    const before = stub.requests.length
    const result = await tool.execute("call-1", {})
    expect(result.isError).toBe(true)
    expect(stub.requests).toHaveLength(before)
  })

  for (const failure of ["callFailure", "echoToken"] as const) {
    it(`#given a credential in ${failure} #when executing #then results errors and logs do not disclose it`, async () => {
      const stub = await mcp({ [failure]: true })
      const host = setup({ reply: () => ({ grant: stub.grant }) })
      await host.start()
      const result = await execute(host.tools()[0])
      expect(result.isError).toBe(true)
      expect(JSON.stringify([result, host.logs])).not.toContain(stub.token())
    })
  }

  for (const missing of ["withRpc", "withRegisterTool"] as const) {
    it(`#given no ${missing} #when starting #then the bridge is a no-op`, async () => {
      const host = setup({ [missing]: false })
      await host.start()
      expect(host.tools()).toEqual([])
      expect(host.pi.rpcEvents).toEqual([])
    })
  }
})
