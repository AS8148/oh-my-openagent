import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"

import { selectEngineTrust } from "../engine-trust-policy"
import { decodeWindowsHelperOutput, encodeBundledRootsForHelper, windowsTrustHelperEnvironment } from "../windows-trust-facts"
import { SyntheticPki } from "./windows-trust-pki"

// The built helper runs in the Windows job of .github/workflows/engine-trust-helper.yml, which sets both variables;
// a required run without the binary fails instead of skipping.
const helper = process.env.OMO_WINDOWS_TRUST_HELPER
if (process.env.OMO_WINDOWS_TRUST_HELPER_REQUIRED === "1" && helper === undefined) {
  throw new Error("OMO_WINDOWS_TRUST_HELPER_REQUIRED=1 but OMO_WINDOWS_TRUST_HELPER is unset")
}
const DEADLINE_MS = 30_000

type Run = { readonly code: number | null; readonly stdout: Uint8Array; readonly stderr: string }
function run(path: string, stdin: Uint8Array): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, [], { env: windowsTrustHelperEnvironment(process.env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    // A circuit breaker above the helper's own 20 s watchdog, never a synchronization point.
    const deadline = setTimeout(() => {
      child.kill()
      reject(new Error(`the helper did not exit within ${DEADLINE_MS} ms`))
    }, DEADLINE_MS)
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.on("error", (error) => {
      clearTimeout(deadline)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(deadline)
      resolve({ code, stdout: new Uint8Array(Buffer.concat(stdout)), stderr: Buffer.concat(stderr).toString("utf8") })
    })
    child.stdin.end(stdin)
  })
}

describe.skipIf(helper === undefined)("windows trust helper on real Crypt32", () => {
  let pki: SyntheticPki | undefined
  let bundled: Uint8Array = new Uint8Array()
  beforeAll(() => {
    pki = new SyntheticPki()
    bundled = pki.root("B").der
  })
  afterAll(() => pki?.dispose())

  test("#given Bun's bundled roots on stdin #when the helper reads this machine's stores #then its output decodes and the policy selects", async () => {
    const result = await run(helper ?? "", encodeBundledRootsForHelper([bundled]))
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" })
    const decoded = decodeWindowsHelperOutput(result.stdout)
    if (decoded.kind !== "decoded") throw new Error(`${decoded.error} at ${decoded.path}`)
    const { facts, sources } = decoded.output
    expect(facts.bundledRoots).toEqual([{
      sha256: createHash("sha256").update(bundled).digest("hex"),
      sha1: createHash("sha1").update(bundled).digest("hex"),
    }])
    // Outcomes only: no store content is asserted.
    const unread = sources.filter((source) => source.store === "Disallowed" && source.outcome !== "read" && source.outcome !== "absent")
    expect({ complete: facts.complete, ctl: decoded.output.ctl, unread }).toEqual({ complete: true, ctl: expect.stringMatching(/^(read|absent)$/), unread: [] })
    const attempted = new Set(sources.filter((source) => source.store === "Disallowed").map((source) => source.location))
    for (const location of ["CURRENT_USER", "LOCAL_MACHINE", "CURRENT_USER_GROUP_POLICY", "LOCAL_MACHINE_GROUP_POLICY", "LOCAL_MACHINE_ENTERPRISE", "USER_SID"] as const) {
      expect(attempted.has(location)).toBe(true)
    }
    expect(selectEngineTrust(facts).status).toBe("selected")
  })

  test("#given stdin that is not a DER certificate list #when the helper runs #then it exits 65 with no stdout", async () => {
    const result = await run(helper ?? "", new Uint8Array([0x30, 0x05, 0x00]))
    expect({ code: result.code, stdout: result.stdout.length, stderr: result.stderr.trim() })
      .toEqual({ code: 65, stdout: 0, stderr: "omo-engine-trust-helper: bad-stdin" })
  })
})
