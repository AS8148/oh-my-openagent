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

async function setup(options: {
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
  await component.register(pi, ctx)
  return {
    pi, logs, handlers,
    start: (id = "A") => pi.dispatch("session_start", { type: "session_start" }, session(id)),
    tools: () => pi.tools.filter((tool) => String(tool.name).startsWith("desktop_")),
  }
}

async function mcp(options: { listFailure?: boolean; callFailure?: boolean; echoToken?: boolean; sse?: boolean; paginated?: boolean; wrongId?: boolean; holdCall?: boolean; redirect?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "desktop-thread-"))
  const tokenFile = join(dir, "bearer")
  let token = `test-credential-${crypto.randomUUID()}`
  await writeFile(tokenFile, token, { mode: 0o600 })
  const requests: { method: unknown; params: unknown; authorized: boolean }[] = []
  const sessions = new Map<string, boolean>()
  const callStarted = Promise.withResolvers<void>()
  let closedSessions = 0
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const authorized = request.headers.get("authorization") === `Bearer ${token}`
      if (!authorized) return new Response("unauthorized", { status: 401 })
      const sessionId = request.headers.get("mcp-session-id")
      if (request.method === "DELETE" && sessionId !== null) {
        sessions.delete(sessionId)
        closedSessions++
        return new Response(null, { status: 204 })
      }
      if (request.method !== "POST") return new Response(null, { status: 405 })
      const body = await request.json()
      if (typeof body !== "object" || body === null || !("method" in body)) return new Response(null, { status: 400 })
      const id = "id" in body ? body.id : undefined
      const params = "params" in body ? body.params : undefined
      requests.push({ method: body.method, params, authorized })
      if (body.method !== "initialize") {
        if (sessionId === null || !sessions.has(sessionId) || request.headers.get("mcp-protocol-version") !== "2025-03-26") {
          return new Response("missing negotiated headers", { status: 400 })
        }
        if (body.method === "notifications/initialized" && id === undefined) {
          sessions.set(sessionId, true)
          return new Response(null, { status: 202 })
        }
        if (!sessions.get(sessionId)) return new Response("not initialized", { status: 400 })
      }
      let result: unknown
      const headers = new Headers()
      if (body.method === "initialize") {
        if (options.redirect) return new Response(null, { status: 307, headers: { location: "/mcp" } })
        const assigned = crypto.randomUUID()
        sessions.set(assigned, false)
        headers.set("mcp-session-id", assigned)
        result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "test-desktop", version: "1" } }
      } else if (body.method === "tools/list") {
        if (options.listFailure) return new Response(token, { status: 500 })
        const cursor = typeof params === "object" && params !== null && "cursor" in params ? params.cursor : undefined
        result = options.paginated && cursor === undefined
          ? { tools: [], nextCursor: "second" }
          : { tools: [{ name: "thread_organize", description: "Organize this desktop thread.", inputSchema: schema }] }
      } else if (body.method === "tools/call") {
        callStarted.resolve()
        if (options.holdCall) return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } })
        if (options.callFailure) return Response.json({ jsonrpc: "2.0", id, error: { code: -32603, message: token } })
        result = { content: options.echoToken ? [{ type: "text", text: token }] : content }
      } else {
        return new Response(null, { status: 400 })
      }
      const response = { jsonrpc: "2.0", id: options.wrongId ? "unrelated" : id, result }
      if (!options.sse) return Response.json(response, { headers })
      headers.set("content-type", "text/event-stream")
      const encoded = new TextEncoder().encode(`: keepalive\r\nevent: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\nevent: message\r\ndata: ${JSON.stringify(response).replace(",", ",\r\ndata: ")}\r\n\r\n`)
      let position = 0
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (position === encoded.length) return
          const end = Math.min(position + 7, encoded.length)
          controller.enqueue(encoded.slice(position, end))
          position = end
          // Keep the SSE response open: clients must stop on the matching response, not EOF.
        },
      }), { headers })
    },
  })
  cleanups.push(async () => { await server.stop(true); await rm(dir, { recursive: true, force: true }) })
  return {
    grant: { endpoint: `http://127.0.0.1:${server.port}/mcp`, tokenFile },
    requests, token: () => token, closedSessions: () => closedSessions, callStarted: callStarted.promise,
    async rotate() { token = `rotated-${crypto.randomUUID()}`; await writeFile(tokenFile, token, { mode: 0o600 }) },
  }
}

async function execute(tool: Record<string, unknown> | undefined, id = "A", signal?: AbortSignal) {
  if (typeof tool?.execute !== "function") throw new Error("desktop tool was not registered")
  return tool.execute("call-1", { title: "Grouped" }, signal, undefined, session(id))
}

describe("desktop thread toolkit", () => {
  it("#given no thread offer #when session starts #then no request or desktop tool", async () => {
    const host = await setup({ offer: "browser" })
    await host.start()
    expect(host.tools()).toEqual([])
    expect(host.pi.rpcEvents).toEqual([])
  })

  for (const sse of [false, true]) {
    it(`#given a grant and ${sse ? "SSE" : "JSON"} MCP #when starting and calling #then schema bearer arguments and content are forwarded`, async () => {
      const stub = await mcp({ sse })
      const host = await setup({ reply: () => ({ grant: stub.grant }) })
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
    const host = await setup({ reply: () => ({ refusal: { reason: secret } }) })
    await host.start()
    expect(host.pi.rpcEvents).toHaveLength(1)
    expect(host.tools()).toEqual([])
    expect(host.logs.length).toBeGreaterThan(0)
    expect(JSON.stringify(host.logs)).not.toContain(secret)
  })

  it("#given no grant reply #when the acquisition deadline expires #then no tools and late grant rejected", async () => {
    const host = await setup({ timeoutMs: 10 })
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
    const host = await setup({ reply: () => ({ grant: stub.grant }) })
    await host.start()
    expect(stub.requests.some((request) => request.method === "tools/list")).toBe(true)
    expect(host.tools()).toEqual([])
    expect(host.logs.length).toBeGreaterThan(0)
    expect(JSON.stringify(host.logs)).not.toContain(stub.token())
  })

  it("#given two registrations from one module #when A's executor is called in B #then B cannot spend A's grant", async () => {
    const stub = await mcp()
    const component = createDesktopToolkitComponent()
    const a = await setup({ component, reply: () => ({ grant: stub.grant }) })
    const b = await setup({ component, offer: "browser" })
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
    const host = await setup({ reply: () => ({ grant: stub.grant }) })
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
      const host = await setup({ reply: () => ({ grant: stub.grant }) })
      await host.start()
      const result = await execute(host.tools()[0])
      expect(result.isError).toBe(true)
      expect(JSON.stringify([result, host.logs])).not.toContain(stub.token())
    })
  }

  for (const missing of ["withRpc", "withRegisterTool"] as const) {
    it(`#given no ${missing} #when starting #then the bridge is a no-op`, async () => {
      const host = await setup({ [missing]: false })
      await host.start()
      expect(host.tools()).toEqual([])
      expect(host.pi.rpcEvents).toEqual([])
    })
  }

  it("#given paginated tools #when discovering #then it follows the cursor and terminates its MCP session", async () => {
    const stub = await mcp({ paginated: true })
    const host = await setup({ reply: () => ({ grant: stub.grant }) })
    await host.start()
    expect(host.tools()).toHaveLength(1)
    expect(stub.requests.filter((request) => request.method === "tools/list").at(-1)?.params).toEqual({ cursor: "second" })
    expect(stub.requests.filter((request) => request.method === "tools/list")).toHaveLength(2)
    expect(stub.closedSessions()).toBe(1)
  })

  it("#given an unrelated response id #when initializing #then no tool is registered", async () => {
    const stub = await mcp({ wrongId: true })
    const host = await setup({ timeoutMs: 20, reply: () => ({ grant: stub.grant }) })
    await host.start()
    expect(host.tools()).toEqual([])
    expect(host.logs.length).toBeGreaterThan(0)
  })

  it("#given a redirect #when initializing #then it is not followed with the bearer", async () => {
    const stub = await mcp({ redirect: true })
    const host = await setup({ reply: () => ({ grant: stub.grant }) })
    await host.start()
    expect(host.tools()).toEqual([])
    expect(stub.requests).toHaveLength(1)
    expect(JSON.stringify(host.logs)).not.toContain(stub.token())
  })

  it("#given an open SSE call #when the caller aborts #then execution settles without leaking credentials", async () => {
    const stub = await mcp({ holdCall: true })
    const host = await setup({ reply: () => ({ grant: stub.grant }) })
    await host.start()
    const controller = new AbortController()
    const running = execute(host.tools()[0], "A", controller.signal)
    await stub.callStarted
    controller.abort()
    const result = await running
    expect(result.isError).toBe(true)
    expect(JSON.stringify([result, host.logs])).not.toContain(stub.token())
  }, 5_000)

  it("#given an open SSE call #when its deadline expires #then execution settles without leaking credentials", async () => {
    const stub = await mcp({ holdCall: true })
    const host = await setup({ timeoutMs: 1_000, reply: () => ({ grant: stub.grant }) })
    await host.start()
    const running = execute(host.tools()[0])
    await stub.callStarted
    const result = await running
    expect(result.isError).toBe(true)
    expect(JSON.stringify([result, host.logs])).not.toContain(stub.token())
  }, 5_000)
})
