import { afterEach, describe, expect, it, spyOn } from "bun:test"
import * as os from "node:os"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { basename, join } from "node:path"

import { automatedRunReason, isOmoNativeTelemetryEnabled } from "./omo-native-session"
import { getOmoNativeAttribution } from "./product-identity"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const ID_A = "a".repeat(64)
const ID_B = "b".repeat(64)
const homedirOf = () => userInfo().homedir
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
    // Windows has no POSIX permission bits (stat reports 0o666): the 0600 mode is asserted only where it exists.
    if (process.platform !== "win32") expect(statSync(canonicalFile(h)).mode & 0o777).toBe(0o600)
  })

  it("#given a flat-layout legacy id and the FIRST post-upgrade run under an orchestrator's agent-dir override #then the user's real legacy id is adopted, not a fresh one", () => {
    const h = home()
    flatLayout(h)
    writeId(join(h, ".omo", "omo-senpi", "omo-native", "install-id"), ID_B)
    expect(attribution({ HOME: h, USERPROFILE: h, OMO_CODING_AGENT_DIR: join(h, "runs", "fresh", "agent") }).install_hash).toBe(sha(ID_B))
    expect(attribution({ HOME: h, USERPROFILE: h }).install_hash).toBe(sha(ID_B))
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
    // Diagnostic for the Windows CI run (#10935): the temp-dir comparison's inputs, as the OS reports them.
    if (process.platform === "win32") console.log("[#10935 diag]", JSON.stringify({ tmpdir: tmpdir(), tmpdirReal: realpathSync(tmpdir()), tmpdirNative: realpathSync.native(tmpdir()), home: h, homeReal: realpathSync(h), homeNative: realpathSync.native(h), accountHome: userInfo().homedir }))
    expect(automatedRunReason({ HOME: h, USERPROFILE: h })).toBe("ephemeral_home")
    expect(automatedRunReason(realHome)).toBeUndefined()
  })

  it("#given a misconfigured temp dir (TMPDIR=/ or one containing the real account home) #then a real user's home is NOT treated as temporary", () => {
    const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP }
    try {
      process.env.TMPDIR = "/"
      process.env.TEMP = "/"
      process.env.TMP = "/"
      expect(automatedRunReason({ HOME: homedirOf(), USERPROFILE: homedirOf() })).toBeUndefined()
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it("#given the automation check throws (os.userInfo with no passwd entry) #then the consent gate never throws and telemetry is OFF for that run", () => {
    const spy = spyOn(os, "userInfo").mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory, uv_os_get_passwd")
    })
    try {
      const gate = () => isOmoNativeTelemetryEnabled({ isConfigEnabled: () => true }, {}, { HOME: "/Users/someone", USERPROFILE: "/Users/someone" })
      expect(gate).not.toThrow()
      expect(gate()).toBe(false)
    } finally {
      spy.mockRestore()
    }
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

describe("temp-home detection is path-correct on every platform (#10935)", () => {
  // Simulated Windows: os.tmpdir() reports the 8.3 short profile name, the home arrives in a different case and long
  // form, and only the native realpath expands both to the same long name.
  const LONG_TEMP = "C:\\Users\\runneradmin\\AppData\\Local\\Temp"
  const nativeWin = (path: string) =>
    path.replace(/^c:\\users\\runner~1/i, "C:\\Users\\runneradmin").replace(/^c:\\users\\runneradmin/i, "C:\\Users\\runneradmin").replace(/\\appdata\\local\\temp/i, "\\AppData\\Local\\Temp")
  const win = { platform: "win32" as const, realpath: nativeWin, tmpdir: () => "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp", homedir: () => "C:\\Users\\runneradmin" }

  it("#given a Windows temp profile (short-name tmpdir, mixed-case long-name home) #then it is an ephemeral home", () => {
    expect(automatedRunReason({ USERPROFILE: "c:\\users\\RunnerAdmin\\appdata\\local\\temp\\omo-x1" }, win)).toBe("ephemeral_home")
    expect(automatedRunReason({ USERPROFILE: "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp" }, win)).toBe("ephemeral_home")
  })

  it("#given the real Windows profile (temp lives UNDER it) #then it is NOT ephemeral, and a prefix sibling is not inside", () => {
    expect(automatedRunReason({ USERPROFILE: "C:\\Users\\runneradmin" }, win)).toBeUndefined()
    expect(automatedRunReason({ USERPROFILE: LONG_TEMP + "-sibling\\x" }, { ...win, realpath: (p: string) => p })).toBeUndefined()
  })

  it("#given a home that cannot be resolved #then it is not ephemeral (the containment check never throws)", () => {
    const missing = { ...win, realpath: (p: string) => { if (/omo-gone/.test(p)) throw new Error("ENOENT"); return nativeWin(p) } }
    expect(automatedRunReason({ USERPROFILE: "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\omo-gone" }, missing)).toBeUndefined()
  })

  it.skipIf(process.platform === "win32")("#given a POSIX symlink inside the temp dir whose target uses '..' to escape it #then the home is NOT inside", () => {
    const root = mkdtempSync(join(tmpdir(), "omo-escape-"))
    const outside = mkdtempSync(join(userInfo().homedir, ".omo-escape-out-"))
    try {
      mkdirSync(join(root, "jump"))
      symlinkSync(join(outside), join(root, "jump", "out"))
      symlinkSync("jump/out/../" + basename(outside), join(root, "entry"))
      expect(automatedRunReason({ HOME: join(root, "entry") }, { tmpdir: () => root })).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
