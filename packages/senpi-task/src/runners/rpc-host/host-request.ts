import { homedir } from "node:os"
import { join } from "node:path"
import { authenticateRpcHost, resolveRpcSocketTransport, RpcIdentityError, withRpcSocket } from "./socket-client"

export type HostReply = Readonly<Record<string, unknown>>

/**
 * One short-lived connection, one command, the reply carrying its id - success or refusal. A daemon
 * broadcasts lifecycle records to every connection, so the first line is not necessarily the answer.
 * Undefined when the host could not be reached or did not answer within `timeoutMs`. The daemon
 * runner uses the logical socket path directly on POSIX and its authenticated named-pipe transport
 * on Windows.
 */
export async function askHost(socket: string, request: HostReply, timeoutMs: number, options: { readonly keyRoot?: string; readonly agentDir?: string } = {}): Promise<HostReply | undefined> {
  const transport = await resolveRpcSocketTransport(socket)
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
