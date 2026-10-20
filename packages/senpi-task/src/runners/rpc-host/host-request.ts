import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, win32 } from "node:path"
import { authenticateRpcHost, RpcIdentityError, withRpcSocket } from "./socket-client"

const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\senpi-rpc-"
const WINDOWS_SECRET_BYTES = 32

export type HostReply = Readonly<Record<string, unknown>>

/**
 * One short-lived connection, one command, the reply carrying its id - success or refusal. A daemon
 * broadcasts lifecycle records to every connection, so the first line is not necessarily the answer.
 * Undefined when the host could not be reached or did not answer within `timeoutMs`. The daemon
 * runner uses the logical socket path directly on POSIX and its authenticated named-pipe transport
 * on Windows.
 */
export async function askHost(socket: string, request: HostReply, timeoutMs: number, options: { readonly keyRoot?: string; readonly agentDir?: string } = {}): Promise<HostReply | undefined> {
  const transport = await resolveTransport(socket)
  if (transport === undefined) return undefined
  const agentDir = options.agentDir ?? [process.env.OMO_CODING_AGENT_DIR, process.env.SENPI_CODING_AGENT_DIR, process.env.PI_CODING_AGENT_DIR]
    .map((value) => value?.trim()).find(Boolean) ?? join(process.env.HOME ?? homedir(), ".omo", "agent")
  const keyRoot = options.keyRoot ?? (process.env.SENPI_RPC_KEY_ROOT?.trim() || agentDir)
  try {
    return await withRpcSocket(transport.address, { timeoutMs, secret: transport.secret }, async (send) => {
      if (process.platform !== "win32") {
        const info = await authenticateRpcHost(send, socket, keyRoot, request.type === "get_protocol_info" ? request : undefined)
        if (request.type === "get_protocol_info") return info
      }
      return await send(request)
    })
  } catch (error) {
    if (error instanceof RpcIdentityError) throw error
    return undefined
  }
}

export function isRecord(value: unknown): value is HostReply {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function resolveTransport(
  socket: string,
): Promise<{ readonly address: string; readonly secret?: Buffer } | undefined> {
  if (process.platform !== "win32") return { address: socket }
  let secret: Buffer
  try {
    secret = await readFile(`${socket}.secret`)
  } catch {
    return undefined
  }
  if (secret.length !== WINDOWS_SECRET_BYTES) return undefined
  const canonical = win32.normalize(socket).toLowerCase()
  const name = createHash("sha256")
    .update(Buffer.concat([Buffer.from(canonical, "utf8"), secret]))
    .digest("hex")
    .slice(0, 32)
  return { address: `${WINDOWS_PIPE_PREFIX}${name}`, secret }
}
