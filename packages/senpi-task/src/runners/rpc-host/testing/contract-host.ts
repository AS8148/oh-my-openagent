import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { once } from "node:events"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fakeHostTransport } from "../__fixtures__/fake-host-transport"

type Frame = Record<string, unknown>
export type ContractHostOptions = {
  readonly legacy?: boolean
  readonly auth?: boolean
  readonly durableId?: string
  readonly otherAttachments?: number
  readonly badProof?: boolean
  readonly prepareRecord?: (path: string, root: string) => void
}
export type ContractHost = {
  readonly socket: string
  readonly root: string
  readonly recordPath: string
  readonly frames: { readonly connection: number; readonly frame: Frame }[]
  readonly mutations: Frame[]
  readonly permissionPreset: () => string
}

/** Enforces the public v1 wire contract, including connection-local attachment ownership. */
export async function withContractHost(options: ContractHostOptions, exercise: (host: ContractHost) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rpc-client-"))
  const socket = join(root, "rpc.sock")
  const transport = fakeHostTransport(socket)
  const launchId = randomUUID()
  const key = randomBytes(32)
  const recordPath = join(root, "rpc", "keys", launchId)
  mkdirSync(join(root, "rpc", "keys"), { recursive: true, mode: 0o700 })
  chmodSync(join(root, "rpc"), 0o700)
  writeFileSync(recordPath, JSON.stringify({
    version: 1, launch_id: launchId, key: key.toString("hex"), pid: process.pid,
    process_start: null, endpoint: socket, created_at: new Date().toISOString(),
  }), { mode: 0o600 })
  options.prepareRecord?.(recordPath, root)
  const frames: ContractHost["frames"] = []
  const mutations: Frame[] = []
  const sockets = new Set<Socket>()
  let nextConnection = 0
  let preset = "read-only"
  const durableId = options.durableId ?? "dur-selected"
  const session = () => ({ sessionId: "rpc-1", durableSessionId: durableId, cwd: root, name: "target" })
  const server = createServer((client) => transport.authenticate(client, () => {
    const connection = nextConnection++
    sockets.add(client)
    client.once("close", () => sockets.delete(client))
    let buffer = ""
    let authenticated = process.platform === "win32" || options.auth !== true
    let attached = false
    let expectedProof = ""
    const respond = (frame: Frame, data: unknown = {}, error?: string) => client.write(`${JSON.stringify({
      id: frame.id, type: "response", command: frame.type, success: error === undefined,
      ...(error === undefined ? { data } : { error, errorCode: error }),
    })}\n`)
    client.setEncoding("utf8")
    client.on("data", (chunk: string) => {
      buffer += chunk
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const frame = JSON.parse(buffer.slice(0, newline)) as Frame
        buffer = buffer.slice(newline + 1)
        frames.push({ connection, frame })
        if (frame.type === "get_protocol_info") {
          const capabilities = options.legacy ? [] : ["attach_session", "release_attachment", "release_caller_aware"]
          if (options.auth && process.platform !== "win32") {
            const clientNonce = (frame.auth as { client_nonce?: string } | undefined)?.client_nonce
            if (typeof clientNonce !== "string" || !/^[0-9a-f]{64}$/.test(clientNonce)) {
              respond(frame, undefined, "auth_required")
              continue
            }
            const serverNonce = randomBytes(32).toString("hex")
            const proof = (label: string, first: string, second: string) =>
              createHmac("sha256", key).update([label, launchId, first, second].join("\n"), "utf8").digest("hex")
            expectedProof = proof("senpi-rpc-client", serverNonce, clientNonce)
            respond(frame, { capabilities: [...capabilities, "socket_auth"], auth: {
              launch_id: launchId, server_nonce: serverNonce,
              server_proof: options.badProof ? "0".repeat(64) : proof("senpi-rpc-server", clientNonce, serverNonce),
            } })
          } else respond(frame, { capabilities })
          continue
        }
        if (frame.type === "authenticate") {
          authenticated = frame.client_proof === expectedProof && expectedProof !== ""
          respond(frame, {}, authenticated ? undefined : "auth_failed")
          continue
        }
        if (!authenticated) { respond(frame, undefined, "auth_required"); continue }
        if (frame.type === "attach_session") {
          if (frame.sessionId !== "rpc-1" || frame.durableSessionId !== durableId) {
            respond(frame, undefined, "session_identity_mismatch")
          } else { attached = true; respond(frame, { sessionId: "rpc-1", attached: true }) }
          continue
        }
        if (frame.type === "release_attachment") { attached = false; respond(frame, { deferred: false }); continue }
        if (frame.type === "list_sessions") { respond(frame, { sessions: [session()] }); continue }
        if (frame.type === "get_messages") { respond(frame, { messages: [] }); continue }
        if (frame.type === "get_state") { respond(frame, { isStreaming: false }); continue }
        if (frame.type === "get_available_models") { respond(frame, { models: [{ provider: "p", id: "m" }] }); continue }
        if (frame.type === "warm") { respond(frame, { warmed: true }); continue }
        if (frame.type === "open_session") {
          attached = true
          if (typeof frame.permissionPreset === "string") preset = frame.permissionPreset
          respond(frame, { sessionId: "rpc-1", state: session() })
          continue
        }
        if (!options.legacy && !attached) { respond(frame, undefined, "session_not_attached"); continue }
        if (frame.type === "release_session" && options.otherAttachments && frame.force !== true) {
          respond(frame, undefined, "attached")
          continue
        }
        mutations.push(frame)
        respond(frame, frame.type === "set_model" ? { provider: frame.provider, id: frame.modelId }
          : frame.type === "release_session" ? { released: true, session_path: join(root, "session.jsonl"), attachments: 0, dropped: { deliveries: [], user_messages: [] } }
          : frame.type === "interrupt" ? { interrupted: true } : {})
      }
    })
  }))
  try {
    const listening = once(server, "listening", { signal: AbortSignal.timeout(2000) })
    server.listen(transport.listenAddress)
    await listening
    await exercise({ socket, root, recordPath, frames, mutations, permissionPreset: () => preset })
  } finally {
    const closed = once(server, "close", { signal: AbortSignal.timeout(2000) })
    for (const client of sockets) client.destroy()
    server.close()
    await closed
    rmSync(root, { recursive: true, force: true })
  }
}
