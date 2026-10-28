import { expect, test } from "bun:test"
import { SkillMcpManager } from "./manager"

type JsonRpcMessage = { id?: number | string; method: string; params?: { protocolVersion?: string } }

// A legacy HTTP+SSE server (protocol 2024-11-05): GET /sse opens the event stream and
// advertises the POST endpoint; responses travel over the stream. Like the servers in #9050,
// it answers a Streamable HTTP POST to the stream URL with 405.
function startLegacySseServer() {
  const encoder = new TextEncoder()
  const received: { method: string; path: string; header: string | null }[] = []
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/sse" && request.method === "GET") {
        received.push({ method: "GET", path: url.pathname, header: request.headers.get("X-Skill-Header") })
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller
            controller.enqueue(encoder.encode("event: endpoint\ndata: /messages?sessionId=legacy\n\n"))
          },
        }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } })
      }
      if (url.pathname !== "/messages" || request.method !== "POST") {
        received.push({ method: request.method, path: url.pathname, header: request.headers.get("X-Skill-Header") })
        return new Response("Method Not Allowed", { status: 405 })
      }
      const message = await request.json() as JsonRpcMessage
      received.push({ method: message.method, path: url.pathname, header: request.headers.get("X-Skill-Header") })
      if (message.id !== undefined) {
        const result = message.method === "initialize"
          ? { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "legacy-sse", version: "1" } }
          : message.method === "tools/list"
            ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
            : undefined
        const reply = result
          ? { jsonrpc: "2.0", id: message.id, result }
          : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }
        stream?.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(reply)}\n\n`))
      }
      return new Response("Accepted", { status: 202 })
    },
  })
  return { server, received }
}

test("#given a type sse skill MCP on a legacy HTTP+SSE server #when listing tools #then it connects over the GET event stream and the advertised POST endpoint", async () => {
  // given
  const { server, received } = startLegacySseServer()
  const manager = new SkillMcpManager()
  const config = { type: "sse" as const, url: new URL("/sse", server.url).href, headers: { "X-Skill-Header": "present" } }

  try {
    // when
    const tools = await manager.listTools(
      { serverName: "legacy-sse", skillName: "test", sessionID: "sse" },
      { skillName: "test", config },
    )

    // then
    expect(tools.map((tool) => tool.name)).toEqual(["echo"])
    expect(received.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /sse",
      "initialize /messages",
      "notifications/initialized /messages",
      "tools/list /messages",
    ])
    expect(received.every(({ header }) => header === "present")).toBe(true)
  } finally {
    await manager.disconnectAll()
    await server.stop(true)
  }
})
