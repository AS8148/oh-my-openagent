import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs"
import { join } from "node:path"

export type RpcObject = Readonly<Record<string, unknown>>
export type RpcRequest = (command: RpcObject, timeoutMs?: number) => Promise<RpcObject>
const HEX_32 = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export class RpcIdentityError extends Error {
  constructor(readonly code: "unsafe_key_record" | "host_identity_unproven" | "auth_failed", location: string) {
    super(`${code}:${location}`)
  }
}

function object(value: unknown): value is RpcObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function readKey(root: string, launchId: string): Buffer | undefined {
  const path = join(root, "rpc", "keys", launchId)
  const unsafe = () => new RpcIdentityError("unsafe_key_record", path)
  let descriptor: number | undefined
  try {
    for (const directory of [root, join(root, "rpc", "keys")]) {
      const stat = lstatSync(directory)
      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700) throw unsafe()
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600) throw unsafe()
    const row: unknown = JSON.parse(readFileSync(descriptor, "utf8"))
    if (!object(row) || row.version !== 1 || row.launch_id !== launchId || typeof row.key !== "string" || !HEX_32.test(row.key)) throw unsafe()
    return Buffer.from(row.key, "hex")
  } catch (error) {
    if (missing(error)) return undefined
    throw unsafe()
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

/** POSIX public endpoint authentication; raw terminal and Windows secret transports never call it. */
export async function authenticateRpcHost(
  request: RpcRequest,
  endpoint: string,
  keyRoot: string | (() => string),
  command: RpcObject = { type: "get_protocol_info", observe: true },
): Promise<RpcObject> {
  const clientNonce = randomBytes(32).toString("hex")
  const reply = await request({ ...command, auth: { client_nonce: clientNonce } }, 2000)
  const data = object(reply.data) ? reply.data : undefined
  if (data?.auth === undefined) return reply
  const auth = data.auth
  if (!object(auth) || typeof auth.launch_id !== "string" || !UUID.test(auth.launch_id)
    || typeof auth.server_nonce !== "string" || !HEX_32.test(auth.server_nonce)
    || typeof auth.server_proof !== "string" || !HEX_32.test(auth.server_proof)) {
    throw new RpcIdentityError("host_identity_unproven", endpoint)
  }
  const root = typeof keyRoot === "function" ? keyRoot() : keyRoot
  const key = readKey(root, auth.launch_id)
  if (key === undefined) {
    console.error(`senpi rpc client: no key record for launch ${auth.launch_id} under ${root}; continuing unauthenticated (refused from the next release; set SENPI_RPC_KEY_ROOT to the host's agent dir)`)
    return reply
  }
  const proof = (label: string, first: string, second: string) =>
    createHmac("sha256", key).update([label, auth.launch_id, first, second].join("\n"), "utf8").digest()
  if (!timingSafeEqual(proof("senpi-rpc-server", clientNonce, auth.server_nonce), Buffer.from(auth.server_proof, "hex"))) {
    throw new RpcIdentityError("host_identity_unproven", endpoint)
  }
  const answer = await request({ type: "authenticate", client_proof: proof("senpi-rpc-client", auth.server_nonce, clientNonce).toString("hex") }, 2000)
  if (answer.success !== true) throw new RpcIdentityError("auth_failed", endpoint)
  return reply
}
