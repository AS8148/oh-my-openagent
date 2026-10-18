import { afterEach, describe, expect, test } from "bun:test"
import dgram from "node:dgram"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import tls from "node:tls"

import type { SenpiExtensionAPI } from "../../extension/types"
import {
  ONBOARDING_APPLY_RPC_METHOD,
  ONBOARDING_SCAN_RPC_EVENT,
  ONBOARDING_SCAN_RPC_METHOD,
  createOnboardingScanComponent,
  type OnboardingApplyResponse,
  type OnboardingScanEvent,
  type OnboardingScanResponse,
} from "./scan-component"

const roots: string[] = []
const SECRET = "SK-SENTINEL-ONBOARDING-SCAN"
const EVENT_TIMEOUT_MS = 20_000

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

type Profile = { home: string; agentDir: string; env: Record<string, string> }

function emptyProfile(): Profile {
  const root = mkdtempSync(join(tmpdir(), "omo-onboarding-scan-"))
  roots.push(root)
  const home = join(root, "home")
  mkdirSync(home, { recursive: true })
  return { home, agentDir: join(home, ".omo", "agent"), env: { HOME: home } }
}

function openCodeProfile(): Profile {
  const profile = emptyProfile()
  write(join(profile.home, ".local", "share", "opencode", "auth.json"), JSON.stringify({
    openai: { type: "api", key: SECRET },
    anthropic: { type: "oauth", refresh: "r", access: "a", expires: 1 },
  }))
  write(join(profile.home, ".config", "opencode", "opencode.json"), JSON.stringify({
    model: "openai/gpt-5",
    mcp: { ctx: { type: "local", command: ["npx", "ctx"] } },
    provider: { myco: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://example.invalid/v1" }, models: { m1: {} } } },
  }))
  return profile
}

type Handler = (data: unknown) => unknown | Promise<unknown>

function fakeHost() {
  const handlers = new Map<string, Handler>()
  const events: OnboardingScanEvent[] = []
  const listeners = new Set<(event: OnboardingScanEvent) => void>()
  const modelAccess: string[] = []
  const rpc = {
    emit(name: string, data: unknown) {
      if (name !== ONBOARDING_SCAN_RPC_EVENT) return
      const event = data as OnboardingScanEvent
      events.push(event)
      for (const listener of listeners) listener(event)
    },
    handle(name: string, handler: Handler) {
      handlers.set(name, handler)
    },
  }
  const pi = new Proxy({ rpc } as Record<string | symbol, unknown>, {
    get(target, key) {
      if (typeof key === "string" && /model/i.test(key)) {
        modelAccess.push(key)
        throw new Error(`onboarding scan touched the model surface: ${key}`)
      }
      return target[key]
    },
  }) as unknown as SenpiExtensionAPI

  function doneOf(scanId: string): Promise<OnboardingScanEvent[]> {
    const own = () => events.filter((candidate) => candidate.scanId === scanId)
    if (own().some((event) => event.kind === "done")) return Promise.resolve(own())
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(listener)
        reject(new Error(`waited ${EVENT_TIMEOUT_MS}ms for the done event of scan ${scanId}, never fired`))
      }, EVENT_TIMEOUT_MS)
      const listener = (event: OnboardingScanEvent) => {
        if (event.scanId !== scanId || event.kind !== "done") return
        clearTimeout(timer)
        listeners.delete(listener)
        resolve(own())
      }
      listeners.add(listener)
    })
  }

  async function scan(request: unknown): Promise<{ scanId: string; events: OnboardingScanEvent[] }> {
    const handler = handlers.get(ONBOARDING_SCAN_RPC_METHOD)
    if (handler === undefined) throw new Error("scan handler not registered")
    const response = await handler(request) as OnboardingScanResponse
    if (!("scanId" in response)) throw new Error(`scan unavailable: ${JSON.stringify(response)}`)
    return { scanId: response.scanId, events: await doneOf(response.scanId) }
  }

  async function apply(request: unknown): Promise<OnboardingApplyResponse> {
    const handler = handlers.get(ONBOARDING_APPLY_RPC_METHOD)
    if (handler === undefined) throw new Error("apply handler not registered")
    return await handler(request) as OnboardingApplyResponse
  }

  return { pi, handlers, events, modelAccess, scan, apply }
}

function register(profile: Profile) {
  const host = fakeHost()
  createOnboardingScanComponent({
    runtime: () => ({ home: profile.home, env: profile.env, agentDir: profile.agentDir }),
  }).register(host.pi, {} as never)
  return host
}

function blockNetwork(): { attempts: string[]; restore(): void } {
  const attempts: string[] = []
  const refuse = (name: string) => () => {
    attempts.push(name)
    throw new Error(`network I/O on the onboarding scan path: ${name}`)
  }
  const patches: Array<[Record<string, unknown>, string, unknown]> = []
  const patch = (target: Record<string, unknown>, key: string, name: string) => {
    patches.push([target, key, target[key]])
    target[key] = refuse(name)
  }
  patch(net.Socket.prototype as unknown as Record<string, unknown>, "connect", "net.Socket.connect")
  patch(net as unknown as Record<string, unknown>, "connect", "net.connect")
  patch(net as unknown as Record<string, unknown>, "createConnection", "net.createConnection")
  patch(tls as unknown as Record<string, unknown>, "connect", "tls.connect")
  patch(http as unknown as Record<string, unknown>, "request", "http.request")
  patch(http as unknown as Record<string, unknown>, "get", "http.get")
  patch(https as unknown as Record<string, unknown>, "request", "https.request")
  patch(https as unknown as Record<string, unknown>, "get", "https.get")
  patch(dgram as unknown as Record<string, unknown>, "createSocket", "dgram.createSocket")
  patch(globalThis as unknown as Record<string, unknown>, "fetch", "fetch")
  patch(Bun as unknown as Record<string, unknown>, "connect", "Bun.connect")
  return {
    attempts,
    restore() {
      for (const [target, key, original] of patches.reverse()) target[key] = original
    },
  }
}

function sourcesOf(events: readonly OnboardingScanEvent[]): string[] {
  return [...new Set(events.filter((event) => event.kind === "source_started").map((event) => event.source))]
}

describe("onboarding scan RPC", () => {
  test("#given the component registers #then it serves the scan and apply methods", () => {
    const host = register(emptyProfile())
    expect([...host.handlers.keys()].sort()).toEqual([ONBOARDING_APPLY_RPC_METHOD, ONBOARDING_SCAN_RPC_METHOD].sort())
    expect(ONBOARDING_SCAN_RPC_METHOD).toBe("omo.onboarding.scan")
    expect(ONBOARDING_APPLY_RPC_METHOD).toBe("omo.onboarding.apply")
    expect(ONBOARDING_SCAN_RPC_EVENT).toBe("omo.onboarding.scan.event")
  })

  test("#given an OpenCode setup #when a scan runs with defaults #then each source streams started, items, done in order and custom providers stay off", async () => {
    const host = register(openCodeProfile())
    const { scanId, events } = await host.scan({})

    expect(sourcesOf(events)).toEqual(["detect", "credentials", "assets", "model-choices"])
    for (const event of events) {
      expect(event.scanId).toBe(scanId)
      expect(typeof event.elapsedMs).toBe("number")
    }
    for (const source of sourcesOf(events)) {
      const own = events.filter((event) => event.source === source)
      expect(own[0]?.kind).toBe("source_started")
      expect(own.at(-1)?.kind).toBe("source_done")
      const items = own.filter((event) => event.kind === "item")
      expect(own.slice(1, -1)).toEqual(items)
      expect(own.at(-1)?.counts?.found).toBe(items.length)
    }
    const boundaries = events.filter((event) => event.kind === "source_started" || event.kind === "source_done").map((event) => `${event.kind}:${event.source}`)
    expect(boundaries).toEqual(sourcesOf(events).flatMap((source) => [`source_started:${source}`, `source_done:${source}`]))
    expect(events.at(-1)?.kind).toBe("done")
    const items = events.filter((event) => event.kind === "item").map((event) => event.item)
    expect(items).toContainEqual(expect.objectContaining({ id: "openai", kind: "api-key", state: "import" }))
    expect(items).toContainEqual(expect.objectContaining({ id: "ctx", kind: "mcp", state: "import" }))
    expect(JSON.stringify(events)).not.toContain(SECRET)
  })

  test("#given includeCustomProviders #when a scan runs #then the provider source streams too", async () => {
    const host = register(openCodeProfile())
    const { events } = await host.scan({ includeCustomProviders: true })
    expect(sourcesOf(events)).toEqual(["detect", "providers", "credentials", "assets", "model-choices"])
    expect(events.filter((event) => event.kind === "item").map((event) => event.item)).toContainEqual(expect.objectContaining({ id: "myco", kind: "provider", state: "import" }))
  })

  test("#given no model configured and the network refused #when a scan and an apply of every stage run #then both complete without a socket or a model lookup", async () => {
    const profile = openCodeProfile()
    const host = register(profile)
    const network = blockNetwork()
    let applied: OnboardingApplyResponse
    try {
      const { scanId } = await host.scan({ includeCustomProviders: true })
      applied = await host.apply({ scanId, stages: ["credentials", "assets", "providers", "model-choices"] })
    } finally {
      network.restore()
    }

    expect(network.attempts).toEqual([])
    expect(host.modelAccess).toEqual([])
    expect(applied).toEqual(expect.objectContaining({ applied: ["credentials", "assets", "providers", "model-choices"] }))
    expect(JSON.parse(readFileSync(join(profile.agentDir, "auth.json"), "utf8")).openai).toBeDefined()
    expect(JSON.parse(readFileSync(join(profile.agentDir, "mcp.json"), "utf8")).mcpServers.ctx).toBeDefined()
    expect(JSON.parse(readFileSync(join(profile.agentDir, "models.json"), "utf8")).providers.myco).toBeDefined()
  })

  test("#given an empty profile #when a scan and an apply run #then they complete and write nothing", async () => {
    const profile = emptyProfile()
    const host = register(profile)
    const { scanId, events } = await host.scan({})
    expect(events.at(-1)?.kind).toBe("done")
    expect(events.filter((event) => event.kind === "source_failed")).toEqual([])
    const applied = await host.apply({ scanId, stages: ["credentials", "assets", "providers", "model-choices"] })
    expect(applied).toEqual(expect.objectContaining({ scanId, applied: [] }))
    expect(existsSync(profile.agentDir)).toBe(false)
  })

  test("#given a scan id the engine does not hold #when apply runs #then it answers unavailable and writes nothing", async () => {
    const profile = openCodeProfile()
    const host = register(profile)
    expect(await host.apply({ scanId: "missing", stages: ["credentials"] })).toEqual(expect.objectContaining({ kind: "unavailable" }))
    expect(existsSync(profile.agentDir)).toBe(false)
  })
})
