import { randomUUID } from "node:crypto"
import { createConnection, type Socket } from "node:net"
import { StringDecoder } from "node:string_decoder"
import type { RpcObject, RpcRequest } from "./socket-auth"

export { authenticateRpcHost, RpcIdentityError } from "./socket-auth"
export type { RpcObject, RpcRequest } from "./socket-auth"

/** A correlated JSONL conversation; broadcasts never settle a request and cleanup owns the socket. */
export async function withRpcSocket<T>(
  endpoint: string,
  options: { readonly timeoutMs: number; readonly secret?: Uint8Array; readonly connect?: (endpoint: string) => Socket },
  operation: (request: RpcRequest) => Promise<T>,
): Promise<T> {
  const socket = (options.connect ?? createConnection)(endpoint)
  const decoder = new StringDecoder("utf8")
  let buffer = ""
  let pending: { id: unknown; resolve: (frame: RpcObject) => void; reject: (error: Error) => void } | undefined
  let failure: Error | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const clear = () => { clearTimeout(timer); timer = undefined }
  let rejectConnect: (error: Error) => void = () => undefined
  const fail = (error: Error) => {
    failure = error
    clear()
    rejectConnect(error)
    pending?.reject(error)
    pending = undefined
  }
  const arm = (timeoutMs: number) => {
    clear()
    timer = setTimeout(() => { fail(new Error("thread RPC request timed out")); socket.destroy() }, Math.min(timeoutMs, options.timeoutMs))
  }
  socket.once("error", fail)
  socket.once("close", () => fail(new Error("thread RPC connection closed before the response arrived")))
  socket.on("data", (chunk: Buffer) => {
    buffer += decoder.write(chunk)
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim() === "") continue
      let frame: unknown
      try { frame = JSON.parse(line) } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); return }
      if (typeof frame !== "object" || frame === null || !("id" in frame) || frame.id !== pending?.id) continue
      const waiter = pending
      pending = undefined
      clear()
      waiter?.resolve(frame as RpcObject)
    }
  })
  const request: RpcRequest = async (command, timeoutMs = options.timeoutMs) => {
    if (failure !== undefined) throw failure
    return await new Promise<RpcObject>((resolve, reject) => {
      const id = command.id ?? randomUUID()
      pending = { id, resolve, reject }
      arm(timeoutMs)
      socket.write(`${JSON.stringify({ ...command, id })}\n`)
    })
  }
  try {
    await new Promise<void>((resolve, reject) => {
      rejectConnect = reject
      arm(options.timeoutMs)
      socket.once("connect", () => {
        clear()
        if (options.secret !== undefined) socket.write(Buffer.from(options.secret))
        resolve()
      })
    })
    return await operation(request)
  } finally {
    clear()
    socket.destroy()
  }
}
