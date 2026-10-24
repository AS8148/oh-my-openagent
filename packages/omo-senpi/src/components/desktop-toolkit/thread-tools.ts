import { readFile } from "node:fs/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"

import type { ToolkitGrant } from "./index"

async function withClient<T>(
  grant: ToolkitGrant,
  timeoutMs: number,
  operation: (client: Client, signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal,
): Promise<T> {
  const deadline = AbortSignal.timeout(timeoutMs)
  const signal = callerSignal === undefined ? deadline : AbortSignal.any([deadline, callerSignal])
  const token = (await readFile(grant.tokenFile, { encoding: "utf8", signal })).trim()
  if (token.length === 0) throw new Error("desktop toolkit credential unavailable")
  const client = new Client({ name: "omo-desktop-thread", version: "1" })
  const transport = new StreamableHTTPClientTransport(new URL(grant.endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: "error" },
    fetch: (url, init) => fetch(url, { ...init, redirect: "error", signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }),
  })
  try {
    await client.connect(transport, { signal, timeout: timeoutMs })
    const result = await operation(client, signal)
    if (JSON.stringify(result).includes(token)) throw new Error("desktop toolkit response contains a credential")
    return result
  } finally {
    await client.close()
  }
}

export function listThreadTools(grant: ToolkitGrant, timeoutMs: number) {
  return withClient(grant, timeoutMs, async (client, signal) => {
    const tools = []
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor }, { signal, timeout: timeoutMs })
      tools.push(...page.tools)
      cursor = page.nextCursor
    } while (cursor !== undefined)
    return tools
  })
}

export async function callThreadTool(
  grant: ToolkitGrant | undefined,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  if (grant === undefined) {
    return { isError: true, content: [{ type: "text", text: "Desktop thread toolkit is not granted to the calling session." }], details: { reason: "no_session_grant" } }
  }
  try {
    const result = await withClient(grant, timeoutMs, (client, requestSignal) =>
      client.callTool({ name, arguments: args }, CallToolResultSchema, { signal: requestSignal, timeout: timeoutMs }), signal)
    return { ...result, details: {} }
  } catch {
    // Neither transport errors nor server replies may disclose the file's bearer.
    return { isError: true, content: [{ type: "text", text: "Desktop thread toolkit call failed." }], details: { reason: "call_failed" } }
  }
}
