import { expect, test } from "bun:test"
import { createServer, connect, Socket } from "node:net"
import { once } from "node:events"
import { attachDesktopSyncChannel } from "./channel"

async function pair() {
  const server = createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("missing test endpoint")
  const accepted = once(server, "connection")
  const engine = connect(address.port, "127.0.0.1")
  const [peer] = await accepted
  server.close()
  if (!(peer instanceof Socket)) throw new Error("missing peer")
  return { engine, peer }
}

test("missing private descriptor is unavailable", async () => {
  expect(await attachDesktopSyncChannel(undefined)).toEqual({
    kind: "unavailable",
    reason: process.platform === "win32" ? "platform_not_supported" : "private_channel_unavailable",
  })
})

test.skipIf(process.platform === "win32")("bootstraps once and sends requests synchronously on the private duplex", async () => {
  // given the real private wire protocol, not an HTTP or CLI account source
  const { engine, peer } = await pair()
  let pending = ""
  const packets: unknown[] = []
  peer.setEncoding("utf8")
  peer.on("data", (chunk) => {
    pending += chunk
    for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
      const packet = JSON.parse(pending.slice(0, end))
      pending = pending.slice(end + 1)
      packets.push(packet)
      peer.write(`${JSON.stringify({ id: packet.id, ok: true, value: packet.op === "bootstrap" ? { child: "test-child" } : { accepted: true } })}\n`)
    }
  })
  try {
    // when memory registration attaches and issues a typed operation
    const result = await attachDesktopSyncChannel(engine)
    if (result.kind !== "connected") throw new Error("channel unavailable")
    const response = await result.channel.request({ op: "operationBegin" })
    // then it uses its own bootstrap capability and no endpoint/token fallback
    expect(response).toEqual({ accepted: true })
    expect(packets).toEqual([
      { id: 1, op: "bootstrap" },
      { id: 2, op: "request", capability: "test-child", request: { op: "operationBegin" } },
    ])
    result.channel.close()
    expect(result.channel.signal.aborted).toBe(true)
  } finally {
    engine.destroy()
    peer.destroy()
  }
})

test.skipIf(process.platform === "win32")("rejects a malformed bootstrap without exposing its body", async () => {
  const { engine, peer } = await pair()
  peer.once("data", () => peer.write('{"id":1,"ok":true,"value":{"child":"test","secret":"canary"}}\n'))
  try {
    expect(await attachDesktopSyncChannel(engine)).toEqual({ kind: "unavailable", reason: "private_channel_unavailable" })
    expect(engine.destroyed).toBe(true)
  } finally { engine.destroy(); peer.destroy() }
})
