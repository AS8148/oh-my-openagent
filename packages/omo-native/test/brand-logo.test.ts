import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { remapSenpiEnvironment } from "../compiled-environment"
import { buildBrandLogo } from "../../../script/build-brand-logo"

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)))
const ICON = readFileSync(join(REPO_ROOT, ".github/assets/omo-icon-light.svg"))
const PREFIX = "data:image/svg+xml;base64,"
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function decodeLogo(logo: unknown): Buffer {
  expect(typeof logo).toBe("string")
  expect((logo as string).startsWith(PREFIX)).toBe(true)
  return Buffer.from((logo as string).slice(PREFIX.length), "base64")
}

describe("OmO brand logo", () => {
  describe("#given the shared logo module", () => {
    // Generated-artifact contract: the committed module is exactly what the generator writes from the asset.
    test("#then it matches what the generator writes from the asset", async () => {
      await buildBrandLogo(true)
    })
  })

  describe("#given the compiled binary environment", () => {
    test("#then SENPI_BRAND carries the OmO name and the OmO icon as its logo", () => {
      const execDir = mkdtempSync(join(tmpdir(), "omo-brand-logo-"))
      roots.push(execDir)
      const brand = JSON.parse(remapSenpiEnvironment({}, execDir).SENPI_BRAND ?? "{}") as { name?: string; logo?: unknown }
      expect(brand.name).toBe("OmO")
      expect(decodeLogo(brand.logo).equals(ICON)).toBe(true)
    })
  })
})
