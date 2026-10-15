import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:https"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  ExtraCaCertificatesError,
  installEngineCaTrust,
  MAX_EXTRA_CA_BYTES,
  parseExtraCaCertificates,
} from "../compiled-ca-trust"

const fixtures = join(import.meta.dir, "fixtures", "ca-trust")
const fixture = (name: string) => readFileSync(join(fixtures, name), "utf8")

describe("parseExtraCaCertificates", () => {
  test("#given one CA PEM twice with CRLF #then returns it once", () => {
    const ca = fixture("ca.pem")
    expect(parseExtraCaCertificates(`${ca}\r\n${ca.replaceAll("\n", "\r\n")}`)).toHaveLength(1)
  })

  test.each([
    ["plain text", "hello"],
    ["a private key", fixture("leaf.key")],
    ["a server certificate", fixture("leaf.pem")],
    ["a CA:FALSE certificate", fixture("not-ca.pem")],
    ["text around a certificate", `junk\n${fixture("ca.pem")}`],
    ["an oversized value", "a".repeat(MAX_EXTRA_CA_BYTES + 1)],
  ])("#given %s #then fails closed", (_name, value) => {
    expect(() => parseExtraCaCertificates(value)).toThrow(ExtraCaCertificatesError)
  })
})

describe("installEngineCaTrust", () => {
  test("#given an invalid OMO_EXTRA_CA_CERTIFICATES #then throws before touching trust", () => {
    let touched = false
    const tls = {
      getCACertificates: () => [],
      setDefaultCACertificates: () => {
        touched = true
      },
    }
    expect(() => installEngineCaTrust({ OMO_EXTRA_CA_CERTIFICATES: "junk" }, tls)).toThrow(ExtraCaCertificatesError)
    expect(touched).toBe(false)
  })

  test("#given a runtime without the trust APIs #then leaves it alone and still sets NODE_USE_SYSTEM_CA", () => {
    const env: NodeJS.ProcessEnv = {}
    expect(installEngineCaTrust(env, {} as never).installed).toBe(false)
    expect(env.NODE_USE_SYSTEM_CA).toBe("1")
  })
})

// The bug is specific to `bun build --compile`: a compiled binary ignores --use-system-ca, so this
// compiles a real probe and connects to a local TLS server whose leaf chains to a private CA.
describe("engine entry", () => {
  test("#given an invalid OMO_EXTRA_CA_CERTIFICATES #then omo refuses to start, even for --version", () => {
    const entry = join(import.meta.dir, "..", "compile-entry.ts")
    const run = spawnSync(process.execPath, [entry, "--version"], {
      env: { ...process.env, OMO_EXTRA_CA_CERTIFICATES: "junk" },
      encoding: "utf8",
    })
    expect(run.status).toBe(78)
    expect(run.stderr).toContain("OMO_EXTRA_CA_CERTIFICATES")
  })
})

describe("compiled binary", () => {
  let dir = ""
  let server: Server
  let port = 0

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "omo-ca-trust-"))
    const entry = join(dir, "probe.ts")
    writeFileSync(
      entry,
      `import { installEngineCaTrust } from ${JSON.stringify(join(import.meta.dir, "..", "compiled-ca-trust.ts"))}
import { request } from "node:https"
import { spawnSync } from "node:child_process"
const [mode, port] = process.argv.slice(2)
if (mode === "install") {
  try { installEngineCaTrust() } catch (error) { console.log("refused " + (error as Error).name); process.exit(3) }
}
if (mode === "daemon") {
  installEngineCaTrust()
  const child = spawnSync(process.execPath, ["install", port], { env: process.env, encoding: "utf8" })
  console.log(child.stdout.trim()); process.exit(0)
}
if (mode === "bun-be-bun") {
  installEngineCaTrust()
  const code = 'const t=require("node:tls");console.log(t.getCACertificates("default").length-t.getCACertificates("bundled").length,t.getCACertificates("system").length)'
  const child = spawnSync(process.execPath, ["-e", code], { env: { ...process.env, BUN_BE_BUN: "1" }, encoding: "utf8" })
  console.log(child.stdout.trim()); process.exit(0)
}
request("https://localhost:" + port + "/", (r) => { r.resume(); console.log("ok " + r.statusCode) })
  .on("error", (e: NodeJS.ErrnoException) => console.log("error " + e.code)).end()
`,
    )
    const built = spawnSync(process.execPath, ["build", "--compile", entry, "--outfile", join(dir, "probe")], { encoding: "utf8" })
    if (built.status !== 0) throw new Error(built.stderr)
    server = createServer({ key: fixture("leaf.key"), cert: fixture("leaf.pem") }, (_req, res) => res.end("ok"))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    port = (server.address() as AddressInfo).port
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  })

  const probe = (mode: string, env: NodeJS.ProcessEnv) =>
    new Promise<string>((resolve) => {
      const child = spawn(join(dir, "probe"), [mode, String(port)], {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: "", NODE_USE_SYSTEM_CA: "", ...env },
      })
      let out = ""
      child.stdout.on("data", (chunk) => (out += chunk))
      child.on("close", () => resolve(out.trim()))
    })

  test("#given the private CA only in OMO_EXTRA_CA_CERTIFICATES #then a plain compiled binary rejects it", async () => {
    expect(await probe("none", { OMO_EXTRA_CA_CERTIFICATES: fixture("ca.pem") })).toBe("error UNABLE_TO_VERIFY_LEAF_SIGNATURE")
  })

  test("#given the private CA in OMO_EXTRA_CA_CERTIFICATES #then the engine trusts it after install", async () => {
    expect(await probe("install", { OMO_EXTRA_CA_CERTIFICATES: fixture("ca.pem") })).toBe("ok 200")
  })

  test("#given an invalid OMO_EXTRA_CA_CERTIFICATES #then the compiled engine refuses to start", async () => {
    expect(await probe("install", { OMO_EXTRA_CA_CERTIFICATES: fixture("not-ca.pem") })).toBe("refused ExtraCaCertificatesError")
  })

  // The host daemon is a grandchild of the process the server spawned: it inherits the variable, not
  // a descriptor, and re-runs this entry, so it must trust the same extra CA.
  test("#given the binary re-run as a grandchild #then it trusts the same extra CA", async () => {
    expect(await probe("daemon", { OMO_EXTRA_CA_CERTIFICATES: fixture("ca.pem") })).toBe("ok 200")
  })

  // A BUN_BE_BUN child never runs this entry; NODE_USE_SYSTEM_CA is how it reads the OS store.
  test("#given a BUN_BE_BUN child #then it trusts the OS store", async () => {
    const [added, system] = (await probe("bun-be-bun", {})).split(" ").map(Number)
    expect(added).toBe(system ?? -1)
  })
})
