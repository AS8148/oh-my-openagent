import { describe, expect, test } from "bun:test"
import { withContractHost, type ContractHost } from "../../../../senpi-task/src/runners/rpc-host/testing/contract-host"
import { createLiveThreadSurface, type LiveThreadSurface } from "./live-surface"
import { createLazyLiveThreadSurface } from "./lazy-live-surface"

function surface(host: ContractHost): LiveThreadSurface {
  return createLiveThreadSurface(undefined, {
    env: { OMO_CODING_AGENT_DIR: host.root, SENPI_RPC_SOCKET: host.socket, SENPI_RPC_KEY_ROOT: host.root },
    statusAll: async () => undefined, registry: async () => [],
  })
}
function endpoint(host: ContractHost) {
  return { kind: "rpc_host" as const, socket: host.socket, routing_id: "rpc-1", durable_session_id: "dur-selected" }
}
const operations: readonly [string, (client: LiveThreadSurface, host: ContractHost) => Promise<unknown>][] = [
  ["interrupt", (client) => Reflect.apply(client.interrupt, client, ["rpc-1", undefined, "dur-selected"])],
  ["set_session_name", (client) => Reflect.apply(client.setSessionName, client, ["rpc-1", "renamed", "dur-selected"])],
  ["set_model", (client) => Reflect.apply(client.setModel, client, ["rpc-1", "p", "m", "dur-selected"])],
  ["set_thinking_level", (client) => Reflect.apply(client.setThinkingLevel, client, ["rpc-1", "high", "turn", "dur-selected"])],
  ["wake", (client, host) => client.gateway.wake(endpoint(host), ["delivery"])],
  ["release_session", (client, host) => client.gateway.releaseSession!(endpoint(host), { reason: "takeover" })],
  ["extension_ui_response", (client, host) => client.gateway.respondUi!(endpoint(host), { ui_request_id: "question", fields: { value: "yes" } })],
]

describe("thread RPC connection-local fenced mutations", () => {
  test.skipIf(process.platform === "win32").each(["environment", "option"] as const)("#given a separate client profile #when the key root comes from %s #then authentication leaves the target preset untouched", async (source) => {
    await withContractHost({ auth: true }, async (host) => {
      const client = createLiveThreadSurface(undefined, {
        env: { OMO_CODING_AGENT_DIR: `${host.root}/profile-b`, SENPI_RPC_SOCKET: host.socket,
          ...(source === "environment" ? { SENPI_RPC_KEY_ROOT: host.root } : {}) },
        ...(source === "option" ? { keyRoot: host.root } : {}),
        statusAll: async () => undefined, registry: async () => [],
      })
      await client.setSessionName("rpc-1", "renamed", "dur-selected")
      expect(host.mutations).toMatchObject([{ type: "set_session_name" }])
      expect(host.permissionPreset()).toBe("read-only")
    })
  })

  test.skipIf(process.platform === "win32")("#given an authenticated enforcing host #when a thread mutation runs #then proof succeeds before attachment", async () => {
    await withContractHost({ auth: true }, async (host) => {
      await Reflect.apply(surface(host).setSessionName, undefined, ["rpc-1", "renamed", "dur-selected"])
      expect(host.mutations).toMatchObject([{ type: "set_session_name" }])
      expect(host.frames.map(({ frame }) => frame.type))
        .toEqual(["get_protocol_info", "authenticate", "attach_session", "set_session_name", "release_attachment"])
    })
  })

  test.each(operations)("#given an enforcing host #when %s runs #then it attaches the selected identity on the same connection", async (command, run) => {
    await withContractHost({ auth: true }, async (host) => {
      await run(surface(host), host)
      expect(host.mutations.map((frame) => frame.type)).toEqual([command])
      const mutation = host.frames.find((entry) => entry.frame.type === command)!
      expect(host.frames.filter((entry) => entry.connection === mutation.connection).map((entry) => entry.frame.type))
        .toEqual(["get_protocol_info", ...(process.platform === "win32" ? [] : ["authenticate"]), "attach_session", command, "release_attachment"])
      expect(host.frames.find((entry) => entry.frame.type === "attach_session")?.frame)
        .toMatchObject({ sessionId: "rpc-1", durableSessionId: "dur-selected" })
      expect(host.permissionPreset()).toBe("read-only")
    })
  })

  test.each(operations)("#given a replacement host reusing rpc-1 #when %s targets the prior durable id #then nothing is mutated", async (_command, run) => {
    await withContractHost({ durableId: "dur-replacement" }, async (host) => {
      await run(surface(host), host).catch(() => undefined)
      expect(host.frames.some((entry) => entry.frame.type === "attach_session")).toBe(true)
      expect(host.mutations).toEqual([])
      expect(host.frames.filter((entry) => !["get_protocol_info", "attach_session"].includes(String(entry.frame.type)))).toEqual([])
    })
  })

  test.each(operations)("#given a today host #when %s runs #then its command fields are unchanged and no attachment is attempted", async (command, run) => {
    await withContractHost({ legacy: true }, async (host) => {
      await run(surface(host), host)
      expect(host.mutations.map((frame) => frame.type)).toEqual([command])
      expect(host.frames.some((entry) => ["attach_session", "authenticate", "release_attachment"].includes(String(entry.frame.type)))).toBe(false)
      expect(host.mutations[0]).not.toHaveProperty("durableSessionId")
      expect(host.mutations[0]).not.toHaveProperty("durable_session_id")
    })
  })

  test("#given another attached caller #when releasing without force #then the original attached refusal survives", async () => {
    await withContractHost({ otherAttachments: 1 }, async (host) => {
      const client = surface(host)
      expect(await client.gateway.releaseSession!(endpoint(host), { reason: "takeover" })).toEqual({ success: false, error: "attached" })
      expect(host.frames.some((entry) => entry.frame.type === "attach_session")).toBe(true)
      expect(await client.gateway.releaseSession!(endpoint(host), { reason: "takeover", force: true })).toMatchObject({ success: true })
    })
  })

  test("#given read operations #when state messages and listing are read #then no attachment is acquired", async () => {
    await withContractHost({}, async (host) => {
      const client = surface(host)
      await client.listSessions()
      await client.getMessages("rpc-1")
      await client.getState("rpc-1")
      expect(host.frames.some((entry) => entry.frame.type === "attach_session")).toBe(false)
    })
  })

  test("#given a named thread create #when opened #then its name is set on the opening connection", async () => {
    await withContractHost({}, async (host) => {
      expect(await surface(host).openSession({ name: "created" })).toMatchObject({ durableSessionId: "dur-selected" })
      const opening = host.frames.find((entry) => entry.frame.type === "open_session")!
      const naming = host.frames.find((entry) => entry.frame.type === "set_session_name")!
      expect(naming.connection).toBe(opening.connection)
      expect(host.mutations).toMatchObject([{ type: "set_session_name", name: "created" }])
    })
  })

  test("#given lazy endpoint forwarding #when a selected session is renamed #then its durable identity survives the facade", async () => {
    await withContractHost({}, async (host) => {
      const client = createLazyLiveThreadSurface(undefined, { loadRuntime: async () => ({ createLiveThreadSurface: () => surface(host) }) })
      const port = client.endpoint(host.socket)
      await Reflect.apply(port.setSessionName, port, ["rpc-1", "renamed", "dur-selected"])
      expect(host.mutations).toMatchObject([{ type: "set_session_name" }])
      expect(host.frames.find((entry) => entry.frame.type === "attach_session")?.frame.durableSessionId).toBe("dur-selected")
    })
  })
})
