import { afterEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { automatedRunReason, isOmoNativeTelemetryEnabled } from "./omo-native-session"
import { getOmoNativeAttribution } from "./product-identity"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const ID_A = "a".repeat(64)
const ID_B = "b".repeat(64)
const sha = (id: string) => createHash("sha256").update(id).digest("hex")

function home(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omo-identity-")))
  roots.push(root)
  return root
}

const canonicalFile = (homeDir: string) => join(homeDir, ".omo", "agent", "omo-senpi", "omo-native", "install-id")

function writeId(path: string, id: string): void {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, `${id}\n`, { mode: 0o600 })
}

function flatLayout(homeDir: string): void {
  mkdirSync(join(homeDir, ".omo"), { recursive: true })
  writeFileSync(join(homeDir, ".omo", "settings.json"), "{}")
}

const attribution = (env: Record<string, string>) => getOmoNativeAttribution({ env, now: new Date(Date.UTC(2027, 0, 1)) })

describe("one anonymous install id per user, independent of the agent home (#10934)", () => {
  it("#given the Desktop's canonical id and a CLI resolving the flat ~/.omo home #then both report ONE install_hash", () => {
    const h = home()
    flatLayout(h)
    writeId(canonicalFile(h), ID_A)
    expect(attribution({ HOME: h, USERPROFILE: h }).install_hash).toBe(sha(ID_A))
  })

  it("#given an agent-dir override (an orchestrator's isolated agent dir per run) #then the id stays the user's canonical id", () => {
    const h = home()
    writeId(canonicalFile(h), ID_A)
    const isolated = join(h, "runs", "run-1", "agent")
    expect(attribution({ HOME: h, USERPROFILE: h, OMO_CODING_AGENT_DIR: isolated }).install_hash).toBe(sha(ID_A))
    expect(attribution({ HOME: h, USERPROFILE: h, SENPI_CODING_AGENT_DIR: join(h, "runs", "run-2") }).install_hash).toBe(sha(ID_A))
  })

  it("#given only a legacy per-agent-home id #then it is adopted once into the canonical file (0600) and kept", () => {
    const h = home()
    flatLayout(h)
    writeId(join(h, ".omo", "omo-senpi", "omo-native", "install-id"), ID_B)
    expect(attribution({ HOME: h, USERPROFILE: h }).install_hash).toBe(sha(ID_B))
    expect(readFileSync(canonicalFile(h), "utf8").trim()).toBe(ID_B)
    expect(statSync(canonicalFile(h)).mode & 0o777).toBe(0o600)
  })

  it("#given no id anywhere #then one is created at the canonical path and every agent home reads it", () => {
    const h = home()
    const first = attribution({ HOME: h, USERPROFILE: h, OMO_CODING_AGENT_DIR: join(h, "x") }).install_hash
    expect(attribution({ HOME: h, USERPROFILE: h }).install_hash).toBe(first)
    expect(sha(readFileSync(canonicalFile(h), "utf8").trim())).toBe(first)
  })

  it("#given OMO_NATIVE_INSTALL_ID (the Desktop pinning a remote runtime) #then it still wins", () => {
    const h = home()
    writeId(canonicalFile(h), ID_A)
    expect(attribution({ HOME: h, USERPROFILE: h, OMO_NATIVE_INSTALL_ID: ID_B }).install_hash).toBe(sha(ID_B))
  })
})

describe("telemetry is off by default for automated runs that cannot hold a stable id (#10934)", () => {
  const realHome = { HOME: "/Users/someone", USERPROFILE: "/Users/someone" }

  it("#given CI, a test runner, or a HOME inside the OS temp dir #then the run is automated", () => {
    expect(automatedRunReason({ ...realHome, CI: "1" })).toBe("ci")
    expect(automatedRunReason({ ...realHome, CI: "false" })).toBeUndefined()
    expect(automatedRunReason({ ...realHome, NODE_ENV: "test" })).toBe("test_runner")
    expect(automatedRunReason({ ...realHome, VITEST: "true" })).toBe("test_runner")
    expect(automatedRunReason({ ...realHome, JEST_WORKER_ID: "1" })).toBe("test_runner")
    const h = home()
    expect(automatedRunReason({ HOME: h, USERPROFILE: h })).toBe("ephemeral_home")
    expect(automatedRunReason(realHome)).toBeUndefined()
  })

  it("#given an automated run #then the enablement gate is off, unless OMO_TELEMETRY_ALLOW_AUTOMATION opts back in", () => {
    const enabled = (env: Record<string, string>) => isOmoNativeTelemetryEnabled({ isConfigEnabled: () => true }, {}, env)
    expect(enabled({ ...realHome })).toBe(true)
    expect(enabled({ ...realHome, CI: "true" })).toBe(false)
    expect(enabled({ ...realHome, NODE_ENV: "test" })).toBe(false)
    expect(enabled({ HOME: home(), USERPROFILE: tmpdir() })).toBe(false)
    expect(enabled({ ...realHome, CI: "true", OMO_TELEMETRY_ALLOW_AUTOMATION: "1" })).toBe(true)
  })
})
