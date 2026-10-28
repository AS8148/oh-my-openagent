/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DESKTOP_ENGINE_RELEASE_HOSTS, desktopEngineReleaseAssetName } from "../packages/senpi-desktop-engine/src/release-assets"
import { PLATFORMS } from "./build-binaries"
import { KEYCHAIN_HELPER_RELEASE_ASSET } from "./release-keychain-helper-target"
import { runBlock } from "./release-workflow-test-steps"

const CAPABILITIES = "omo-runtime-capabilities.json"
const CAPABILITIES_BYTES = '{"keychainHandoff":1}\n'
const SUBPROCESS_TEST_TIMEOUT_MS = 30_000
const SUBPROCESS_SPAWN_TIMEOUT_MS = 20_000

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n")
const publishWorkflow = read("../.github/workflows/publish.yml")
const platformWorkflow = read("../.github/workflows/publish-platform.yml")

type Release = { readonly writer: boolean; readonly capabilities: string | null; readonly listCapabilities: boolean }

function verifyRelease({ writer, capabilities, listCapabilities }: Release): ReturnType<typeof spawnSync> {
  const root = mkdtempSync(join(tmpdir(), "omo-capabilities-verify-"))
  try {
    const assets = join(root, "assets")
    mkdirSync(assets)
    mkdirSync(join(root, "checkout", "script"), { recursive: true })
    writeFileSync(join(root, "checkout", "script", "build-omo-binary.ts"), writer ? `writeFileSync(join(outDir, "${CAPABILITIES}"), bytes)\n` : "// no capability file\n")
    const line = (name: string, bytes: string): string => {
      writeFileSync(join(assets, name), bytes)
      return `${createHash("sha256").update(bytes).digest("hex")}  ${name}`
    }
    const launchers = [
      ...PLATFORMS.map(({ platform }) => `omo-${platform}${platform.startsWith("windows-") ? ".exe" : ""}`),
      KEYCHAIN_HELPER_RELEASE_ASSET,
    ].map((name) => line(name, `bytes of ${name}\n`))
    if (capabilities !== null) {
      const capabilityLine = line(CAPABILITIES, capabilities)
      if (listCapabilities) launchers.push(capabilityLine)
    }
    writeFileSync(join(assets, "SHA256SUMS"), `${launchers.join("\n")}\n`)
    const engines = DESKTOP_ENGINE_RELEASE_HOSTS.map((host) => line(desktopEngineReleaseAssetName(host) ?? "", "engine\n"))
    writeFileSync(join(assets, "senpi-desktop-engine-checksums.txt"), `${engines.join("\n")}\n`)
    const bin = join(root, "bin")
    mkdirSync(bin)
    writeFileSync(join(bin, "gh"), '#!/bin/bash\n[ "$1" = release ] && [ "$2" = download ] || exit 1\ncp "$ASSET_SOURCE_DIR"/* "${@: -1}/"\n')
    chmodSync(join(bin, "gh"), 0o755)
    if (spawnSync("bash", ["-c", "command -v shasum"], { timeout: SUBPROCESS_SPAWN_TIMEOUT_MS }).status !== 0) {
      writeFileSync(join(bin, "shasum"), '#!/bin/bash\n[ "$1" = -a ] && [ "$2" = 256 ] || exit 2\nshift 2\nexec sha256sum "$@"\n')
      chmodSync(join(bin, "shasum"), 0o755)
    }
    const verify = runBlock(publishWorkflow, "      - name: Verify uploaded assets\n", "      - name: Delete draft release\n")
    return spawnSync("bash", ["-e", "-c", verify], {
      cwd: join(root, "checkout"),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, VERSION: "5.0.0", ASSET_SOURCE_DIR: assets, TMPDIR: root },
      encoding: "utf8",
      timeout: SUBPROCESS_SPAWN_TIMEOUT_MS,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe("runtime capability file as a release asset (#11262 RULING-74)", () => {
  test("rides the omo-* release-binary artifact, checksum and upload globs, and is restored on partial reruns", () => {
    expect(spawnSync("bash", ["-c", `[[ ${CAPABILITIES} == omo-* ]]`]).status).toBe(0)
    expect(platformWorkflow).toContain("name: release-binary-${{ matrix.platform }}\n          path: .omo/release-binaries/omo-*\n")
    const upload = runBlock(publishWorkflow, "      - name: Upload release assets\n", "      - name: Verify uploaded assets\n")
    expect(upload).toContain(`grep -qF ${CAPABILITIES} script/build-omo-binary.ts; then\n  gh release download "v\${VERSION}" --pattern ${CAPABILITIES} --dir .omo/release-binaries`)
    expect(upload.indexOf(`--pattern ${CAPABILITIES}`)).toBeLessThan(upload.indexOf("shasum -a 256 omo-* > SHA256SUMS"))
    expect(upload).toContain('gh release upload "v${VERSION}" .omo/release-binaries/omo-*')
  })

  test("is required, listed in SHA256SUMS and byte-exact once the released builder writes it", () => {
    const complete = verifyRelease({ writer: true, capabilities: CAPABILITIES_BYTES, listCapabilities: true })
    expect(complete.status, String(complete.stderr)).toBe(0)
    expect(complete.stdout).toContain("Verified 22/22 release assets")

    for (const release of [
      { writer: true, capabilities: null, listCapabilities: false },
      { writer: true, capabilities: CAPABILITIES_BYTES, listCapabilities: false },
      { writer: true, capabilities: '{"keychainHandoff":2}\n', listCapabilities: true },
    ] satisfies Release[]) {
      expect(verifyRelease(release).status, JSON.stringify(release)).not.toBe(0)
    }
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  test("is tolerated as absent while the released builder does not write it yet", () => {
    const before = verifyRelease({ writer: false, capabilities: null, listCapabilities: false })
    expect(before.status, String(before.stderr)).toBe(0)
    expect(before.stdout).toContain("Verified 21/21 release assets")
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})
