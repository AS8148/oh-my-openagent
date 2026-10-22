import { log } from "@oh-my-opencode/utils"
import { authRequiredError, type RpcObject, type RpcRequest } from "@oh-my-opencode/senpi-task/rpc-socket-client"

const MUTATIONS: ReadonlySet<string> = new Set(["prompt", "interrupt", "set_session_name", "set_model", "set_thinking_level", "wake", "release_session", "extension_ui_response"])

function errorCodeOf(frame: RpcObject): unknown {
  return frame.errorCode ?? frame.error
}

function errorReasonOf(frame: RpcObject): unknown {
  const data = frame.errorData
  return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>).reason : undefined
}

/**
 * Attaches the selected session on this connection. A draining host refuses with the v1 code
 * `session_busy_lifecycle` and `errorData.reason: "host_draining"`: nothing was attached and the
 * entry is unchanged, so it surfaces as the transient `host_draining:` error (retry after the
 * restart), never as an abort or close. `session_not_attached` (v1.1) is typed the same way; only
 * its code is read, never `errorData.action`.
 */
async function attachSelectedSession(request: RpcRequest, socketPath: string, sessionId: unknown, durableSessionId: string): Promise<void> {
  const frame = await request({ type: "attach_session", sessionId, durableSessionId })
  if (frame.success === true) return
  const code = errorCodeOf(frame)
  if (code === "session_busy_lifecycle" && errorReasonOf(frame) === "host_draining") throw new Error(`host_draining:${socketPath}`)
  if (code === "session_not_attached") throw new Error(`session_not_attached:${String(sessionId)}`)
  if (code === "auth_required") throw authRequiredError(socketPath)
  throw new Error(`thread RPC request failed: ${JSON.stringify(frame.error ?? frame)}`)
}

/**
 * Releases the hold after the mutation already took effect, so no outcome here may turn that
 * success into an error. `session_not_attached` means the hold is already gone: released. Any
 * other refusal or a lost connection leaves at most a connection-local hold the host drops when
 * this one-shot connection closes; it is logged once and the mutation's result stands.
 */
async function releaseAttachment(request: RpcRequest, sessionId: unknown): Promise<void> {
  let failure: string
  try {
    const frame = await request({ type: "release_attachment", sessionId })
    if (frame.success === true || errorCodeOf(frame) === "session_not_attached") return
    failure = JSON.stringify(frame.error ?? frame)
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }
  log(`thread rpc: release_attachment for ${String(sessionId)} failed after the mutation took effect: ${failure}`)
}

/**
 * Runs one command on an authenticated connection under the v1.1 attachment fence. Only a
 * session-scoped mutation is fenced, as the host gates only commands that name a session: a wake
 * with no routing id carries no `sessionId` and is sent as it always was.
 */
export async function fencedCommand(
  request: RpcRequest,
  socketPath: string,
  command: RpcObject,
  capabilities: ReadonlySet<unknown>,
  durableSessionId: string | undefined,
  send: () => Promise<RpcObject>,
): Promise<RpcObject> {
  const attach = MUTATIONS.has(String(command.type)) && command.sessionId !== undefined && capabilities.has("attach_session")
    && (command.type !== "release_session" || capabilities.has("release_caller_aware"))
  if (!attach) return await send()
  if (durableSessionId === undefined) throw new Error("session_identity_mismatch:missing selected durable session id")
  await attachSelectedSession(request, socketPath, command.sessionId, durableSessionId)
  const result = await send()
  if (capabilities.has("release_attachment")) await releaseAttachment(request, command.sessionId)
  return result
}
