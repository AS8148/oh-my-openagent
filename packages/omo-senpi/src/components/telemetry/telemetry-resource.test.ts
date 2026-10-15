import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { buildTelemetryArtifacts } from "./telemetry-artifact"
import { createOmoNativeResource } from "./telemetry-resource"

const created: string[] = []
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const MODULE = new URL("./telemetry-resource.ts", import.meta.url).pathname
const SCRIPT = `
const { createOmoNativeResource } = await import(${JSON.stringify(MODULE)})
const resource = createOmoNativeResource({ sdk: { name: "opentelemetry", version: "2.1.0" }, packageVersion: "5.1.33", stateDir: process.env.TC_STATE_DIR })
await Bun.sleep(150)
process.stdout.write(JSON.stringify(resource))
`

function matchesSpec(spec: { readonly values?: readonly string[]; readonly pattern?: string; readonly type: string }, value: unknown): boolean {
  if (spec.type === "boolean") return typeof value === "boolean"
  if (spec.type === "number") return typeof value === "number"
  if (spec.values !== undefined) return spec.values.includes(String(value))
  return spec.pattern !== undefined && new RegExp(spec.pattern, "u").test(String(value))
}

describe("OmO native OTLP Resource", () => {
  test("#given two concurrent processes on one install #then they share omo.install.hash and never share service.instance.id", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "omo-resource-"))
    created.push(stateDir)
    const spawnOne = () =>
      Bun.spawn([process.execPath, "-e", SCRIPT], {
        env: { ...process.env, TC_STATE_DIR: stateDir, OMO_NATIVE_INSTALL_ID: "" },
        stdout: "pipe",
        stderr: "inherit",
      })
    const children = [spawnOne(), spawnOne()]
    const outputs = await Promise.all(children.map(async (child) => {
      const text = await new Response(child.stdout).text()
      expect(await child.exited).toBe(0)
      return JSON.parse(text) as Record<string, unknown>
    }))
    const [first, second] = outputs
    expect(first?.["service.instance.id"]).toMatch(/^[0-9a-f]{32}$/)
    expect(second?.["service.instance.id"]).toMatch(/^[0-9a-f]{32}$/)
    expect(first?.["service.instance.id"]).not.toBe(second?.["service.instance.id"])
    expect(first?.["omo.install.hash"]).toMatch(/^[0-9a-f]{64}$/)
    expect(first?.["omo.install.hash"]).toBe(second?.["omo.install.hash"])
  })

  test("#given this process #then every Resource attribute conforms to the omo-senpi artifact, and omo-cloud carries no install hash", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "omo-resource-"))
    created.push(stateDir)
    const [senpi, cloud] = buildTelemetryArtifacts()
    const fakeOs = { platform: () => "linux", release: () => "6.8.0-45-generic", arch: () => "x64" }
    const resource = createOmoNativeResource({ sdk: { name: "opentelemetry", version: "2.1.0" }, packageVersion: "5.1.33", stateDir, env: {}, os: fakeOs })
    for (const [key, spec] of Object.entries(senpi?.resource ?? {})) {
      if (spec.required) expect(resource).toHaveProperty([key])
      if (resource[key] !== undefined) expect(`${key} ${matchesSpec(spec, resource[key])}`).toBe(`${key} true`)
    }
    expect(resource["host.arch"]).toBe("amd64")
    const cloudResource = createOmoNativeResource({ product: "omo-cloud", sdk: { name: "opentelemetry", version: "2.1.0" }, packageVersion: "5.1.33", env: {}, os: fakeOs })
    expect(cloudResource).not.toHaveProperty(["omo.install.hash"])
    for (const [key, spec] of Object.entries(cloud?.resource ?? {})) {
      if (spec.required) expect(cloudResource).toHaveProperty([key])
      if (cloudResource[key] !== undefined) expect(matchesSpec(spec, cloudResource[key])).toBe(true)
    }
  })
})
