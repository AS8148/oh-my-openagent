import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { JSONRPCRequest, RequestId } from "@modelcontextprotocol/sdk/types.js"
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js"

const modernVersion = "2026-07-28"

export function createProtocolTransport(transport: Transport): Transport {
  let era: "probing" | "modern" | "legacy" = "probing"
  let initialize: JSONRPCRequest | undefined
  let discoveryTimer: ReturnType<typeof setTimeout> | undefined
  let fallbackID: string | undefined
  let fallbackSequence = 0
  const discoveryID = "skill-mcp-discover"
  const pending = new Map<RequestId, JSONRPCRequest>()
  const rejected = new Map<RequestId, JSONRPCRequest>()

  function failInitialization(error: unknown): void {
    if (!initialize) return
    bridge.onmessage?.({
      jsonrpc: "2.0", id: initialize.id,
      error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
    })
  }

  function failFallback(error: unknown): void {
    fallbackID = undefined
    const message = error instanceof Error ? error.message : String(error)
    for (const id of rejected.keys()) {
      bridge.onmessage?.({ jsonrpc: "2.0", id, error: { code: -32000, message } })
    }
    rejected.clear()
  }

  function withMetadata(request: JSONRPCRequest): JSONRPCRequest {
    return {
      ...request,
      params: {
        ...request.params,
        _meta: {
          ...request.params?._meta,
          "io.modelcontextprotocol/protocolVersion": modernVersion,
          "io.modelcontextprotocol/clientInfo": initialize?.params?.clientInfo,
          "io.modelcontextprotocol/clientCapabilities": initialize?.params?.capabilities ?? {},
        },
      },
    }
  }

  async function useLegacy(): Promise<void> {
    if (!initialize) throw new Error("MCP initialization request is missing")
    clearTimeout(discoveryTimer)
    era = "legacy"
    transport.setProtocolVersion?.(String(initialize.params?.protocolVersion))
    await transport.send(initialize)
  }

  // SDK v1 still needs local initialization state for schema/capability checks.
  // Its initialize is translated to discovery, never sent to a modern server.
  const bridge: Transport = {
    async start() {
      transport.onclose = () => {
        clearTimeout(discoveryTimer)
        pending.clear()
        rejected.clear()
        bridge.onclose?.()
      }
      transport.onerror = (error) => bridge.onerror?.(error)
      transport.onmessage = (message, extra) => {
        if (initialize && "id" in message && message.id !== undefined && !("method" in message)) {
          if (message.id === discoveryID) {
            if (era !== "probing") return
            clearTimeout(discoveryTimer)
            if ("result" in message && Array.isArray(message.result.supportedVersions)
              && message.result.supportedVersions.includes(modernVersion)) {
              era = "modern"
              const serverInfo = message.result._meta?.["io.modelcontextprotocol/serverInfo"]
              bridge.onmessage?.({
                jsonrpc: "2.0", id: initialize.id,
                result: {
                  protocolVersion: initialize.params?.protocolVersion,
                  capabilities: message.result.capabilities ?? {},
                  serverInfo: serverInfo ?? { name: "MCP server", version: "unknown" },
                  ...(typeof message.result.instructions === "string" ? { instructions: message.result.instructions } : {}),
                },
              }, extra)
            } else {
              void useLegacy().catch(failInitialization)
            }
            return
          }
          if (message.id === fallbackID) {
            fallbackID = undefined
            if ("error" in message) {
              for (const id of rejected.keys()) bridge.onmessage?.({ ...message, id }, extra)
              rejected.clear()
            } else {
              const negotiated = message.result.protocolVersion
              if (typeof negotiated !== "string" || !SUPPORTED_PROTOCOL_VERSIONS.includes(negotiated)) {
                failFallback(new Error(`Server's protocol version is not supported: ${String(negotiated)}`))
                return
              }
              era = "legacy"
              transport.setProtocolVersion?.(negotiated)
              void (async () => {
                await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" })
                const requests = [...rejected.values()]
                rejected.clear()
                for (const request of requests) await transport.send(request)
              })().catch(failFallback)
            }
            return
          }
          const request = pending.get(message.id)
          pending.delete(message.id)
          if (request && "error" in message && message.error.code === -32022) {
            if (era === "legacy") {
              void transport.send(request).catch((error: Error) => bridge.onerror?.(error))
              return
            }
            rejected.set(request.id, request)
            if (!fallbackID) {
              fallbackID = `skill-mcp-legacy-${fallbackSequence++}`
              transport.setProtocolVersion?.(String(initialize.params?.protocolVersion))
              void transport.send({ ...initialize, id: fallbackID })
                .catch(failFallback)
            }
            return
          }
          if (request && "result" in message) {
            const resultType = message.result.resultType
            if (resultType !== undefined && resultType !== "complete") {
              bridge.onmessage?.({
                jsonrpc: "2.0", id: message.id,
                error: {
                  code: -32000,
                  message: resultType === "input_required"
                    ? "Skill MCP does not support elicitation; the input-required operation was terminated."
                    : `Skill MCP received unsupported resultType: ${String(resultType)}`,
                },
              }, extra)
              return
            }
          }
        }
        bridge.onmessage?.(message, extra)
      }
      await transport.start()
    },
    async send(message, options) {
      if ("method" in message && message.method === "initialize" && "id" in message && !initialize) {
        initialize = message
        transport.setProtocolVersion?.(modernVersion)
        discoveryTimer = setTimeout(() => {
          void useLegacy().catch(failInitialization)
        }, 5_000)
        try {
          await transport.send(withMetadata({ ...message, id: discoveryID, method: "server/discover", params: {} }), options)
        } catch {
          await useLegacy()
        }
        return
      }
      if (era === "modern" && "method" in message) {
        if (message.method === "notifications/initialized") return
        if ("id" in message) {
          if (fallbackID) {
            rejected.set(message.id, message)
            return
          }
          pending.set(message.id, message)
          await transport.send(withMetadata(message), options)
          return
        }
      }
      await transport.send(message, options)
    },
    async close() {
      clearTimeout(discoveryTimer)
      await transport.close()
    },
    setProtocolVersion(version) {
      transport.setProtocolVersion?.(era === "modern" ? modernVersion : version)
    },
  }
  return bridge
}
