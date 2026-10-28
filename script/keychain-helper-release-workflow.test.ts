/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { load } from "js-yaml"
import { z } from "zod"

import { KEYCHAIN_HELPER_IDENTIFIER } from "../packages/omo-native/keychain-helper/build"
import { KEYCHAIN_HELPER_PAYLOAD, KEYCHAIN_HELPER_RELEASE_ASSET, KEYCHAIN_HELPER_SOURCE } from "./release-keychain-helper-target"
import { runBlock } from "./release-workflow-test-steps"

const SUBPROCESS_TEST_TIMEOUT_MS = 30_000
const SUBPROCESS_SPAWN_TIMEOUT_MS = 20_000
const MATERIAL = ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"] as const
const HELPER_BYTES = "synthetic universal keychain helper\n"

const readWorkflow = (name: string): string =>
  readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n")
const platformWorkflow = readWorkflow("publish-platform.yml")
const publishWorkflow = readWorkflow("publish.yml")

const stepSchema = z.object({
  name: z.string().optional(),
  if: z.string().optional(),
  run: z.string().optional(),
  uses: z.string().optional(),
  env: z.record(z.string(), z.unknown()).optional(),
  with: z.record(z.string(), z.unknown()).optional(),
})
type Step = z.infer<typeof stepSchema>
const workflowSchema = z.object({
  jobs: z.record(z.string(), z.object({
    needs: z.union([z.string(), z.array(z.string())]).optional(),
    "runs-on": z.string().optional(),
    if: z.string().optional(),
    steps: z.array(stepSchema).optional(),
  })),
})

function jobSteps(source: string, job: string): Step[] {
  const steps = workflowSchema.parse(load(source)).jobs[job]?.steps
  if (steps === undefined) throw new Error(`job ${job} has no steps`)
  return steps
}

function stepAt(steps: readonly Step[], name: string): { readonly index: number; readonly value: Step } {
  const index = steps.findIndex((candidate) => candidate.name === name)
  const value = steps[index]
  if (value === undefined) throw new Error(`missing workflow step: ${name}`)
  return { index, value }
}

function bash(script: string, cwd: string, env: Record<string, string>): ReturnType<typeof spawnSync> {
  return spawnSync("bash", ["-e", "-c", script], {
    cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: SUBPROCESS_SPAWN_TIMEOUT_MS,
  })
}

function helperTarball(root: string): string {
  const source = join(root, "signed")
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, "omo-keychain"), HELPER_BYTES)
  chmodSync(join(source, "omo-keychain"), 0o755)
  mkdirSync(join(root, ".omo", "keychain-helper"), { recursive: true })
  const tar = spawnSync("tar", ["-czf", join(root, ".omo", "keychain-helper", "omo-keychain.tar.gz"), "-C", source, "omo-keychain"], { timeout: SUBPROCESS_SPAWN_TIMEOUT_MS })
  if (tar.status !== 0) throw new Error("tar failed")
  return root
}

function withRoot(prefix: string, body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), prefix))
  try {
    body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const mode = (path: string): number => statSync(path).mode & 0o777

describe("keychain helper release workflows (#11262)", () => {
  test("every edited workflow parses as YAML into a job graph", () => {
    for (const name of ["publish-platform.yml", "publish.yml", "ci.yml"]) {
      const jobs = workflowSchema.parse(load(readWorkflow(name))).jobs
      expect(Object.keys(jobs).length, name).toBeGreaterThan(0)
    }
  })

  test("one macOS job builds, signs with the explicit identifier, notarizes and gates the helper before upload", () => {
    const workflow = workflowSchema.parse(load(platformWorkflow))
    const job = workflow.jobs["keychain-helper"]
    const steps = jobSteps(platformWorkflow, "keychain-helper")
    const build = stepAt(steps, "Build universal keychain helper")
    const sign = stepAt(steps, "Sign and notarize keychain helper")
    const verify = stepAt(steps, "Verify keychain helper signature")
    const pack = stepAt(steps, "Package keychain helper artifacts")
    const tarball = stepAt(steps, "Upload keychain helper artifact")
    const asset = stepAt(steps, "Upload keychain helper release asset artifact")

    expect(job?.["runs-on"]).toBe("macos-latest")
    expect(job?.if).toBe("github.repository == 'code-yeongyu/oh-my-openagent'")
    expect(workflow.jobs.build?.needs).toEqual(["desktop-engine", "keychain-helper"])
    expect([build.index, sign.index, verify.index, pack.index, tarball.index, asset.index]).toEqual(
      [build.index, sign.index, verify.index, pack.index, tarball.index, asset.index].slice().sort((a, b) => a - b),
    )
    expect(build.value.run).toContain('bun packages/omo-native/keychain-helper/build.ts --out "$HELPER_DIR/omo-keychain"')
    for (const name of MATERIAL) expect(sign.value.env?.[name]).toBe(`\${{ secrets.${name} }}`)
    expect(sign.value.env?.MACOS_SIGNING_REQUIRED).toBe("true")
    expect(sign.value.run).toContain(`bash .github/scripts/macos-sign-and-notarize.sh --identifier ${KEYCHAIN_HELPER_IDENTIFIER} "$KEYCHAIN_HELPER"`)
    expect(sign.value.run).not.toContain("--entitlements")
    expect(sign.value.run).not.toContain("--sign-only")
    expect(verify.value.run).toBe('bun script/keychain-helper-release.ts verify "$KEYCHAIN_HELPER"')
    expect(tarball.value.with).toMatchObject({ name: "keychain-helper", path: ".omo/keychain-helper/omo-keychain.tar.gz", "if-no-files-found": "error" })
    expect(asset.value.with).toMatchObject({ name: `release-binary-omo-keychain`, path: `.omo/release-binaries/${KEYCHAIN_HELPER_RELEASE_ASSET}`, "if-no-files-found": "error" })
  })

  test.skipIf(process.platform === "win32")("packages a mode-preserving tarball and the release asset from the signed file", () => {
    withRoot("omo-keychain-pack-", (root) => {
      const signed = join(root, "runner-temp", "omo-keychain")
      mkdirSync(join(root, "runner-temp"), { recursive: true })
      writeFileSync(signed, HELPER_BYTES)
      chmodSync(signed, 0o644)
      const result = bash(runBlock(platformWorkflow, "      - name: Package keychain helper artifacts\n", "      - name: Upload keychain helper artifact\n"), root, { KEYCHAIN_HELPER: signed })
      expect(result.status, String(result.stderr)).toBe(0)

      const extracted = join(root, "extracted")
      mkdirSync(extracted)
      expect(spawnSync("tar", ["-xzf", join(root, ".omo/keychain-helper/omo-keychain.tar.gz"), "-C", extracted]).status).toBe(0)
      expect(mode(join(extracted, "omo-keychain"))).toBe(0o755)
      expect(readFileSync(join(root, ".omo/release-binaries", KEYCHAIN_HELPER_RELEASE_ASSET), "utf8")).toBe(HELPER_BYTES)
    })
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  test.skipIf(process.platform === "win32")("darwin build legs stage the helper for the compiled payload and the platform package before both builds", () => {
    const steps = jobSteps(platformWorkflow, "build")
    const launcher = stepAt(steps, "Build launcher")
    const download = stepAt(steps, "Download keychain helper")
    const stage = stepAt(steps, "Stage keychain helper")
    const compile = stepAt(steps, "Build release binary")
    const compress = stepAt(steps, "Compress binary")
    const darwinGate = "startsWith(matrix.platform, 'darwin-') && (steps.release-assets.outputs.binary_exists != 'true' || steps.check.outputs.skip != 'true')"

    expect(launcher.index).toBeLessThan(download.index)
    expect(download.index).toBeLessThan(stage.index)
    expect(stage.index).toBeLessThan(compile.index)
    expect(stage.index).toBeLessThan(compress.index)
    expect(download.value.if).toBe(darwinGate)
    expect(stage.value.if).toBe(darwinGate)
    expect(download.value.with).toEqual({ name: "keychain-helper", path: ".omo/keychain-helper" })

    const script = runBlock(platformWorkflow, "      - name: Stage keychain helper\n", "      - name: Build release binary\n")
    for (const packageSkip of ["false", "true"]) {
      withRoot("omo-keychain-stage-", (root) => {
        helperTarball(root)
        const result = bash(script, root, { PLATFORM: "darwin-arm64", PACKAGE_SKIP: packageSkip })
        expect(result.status, String(result.stderr)).toBe(0)
        expect(mode(join(root, KEYCHAIN_HELPER_SOURCE))).toBe(0o755)
        const packaged = join(root, "packages/oh-my-opencode-darwin-arm64/bin/omo-keychain")
        expect(existsSync(packaged)).toBe(packageSkip === "false")
        if (packageSkip === "false") {
          expect(mode(packaged)).toBe(0o755)
          expect(readFileSync(packaged, "utf8")).toBe(HELPER_BYTES)
        }
      })
    }
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  test("the native darwin smoke checks the provisioned helper against its requirement", () => {
    const smoke = stepAt(jobSteps(platformWorkflow, "build"), "Smoke test release binary").value.run ?? ""
    expect(smoke).toContain(`local helper="\${HOME}/.omo/binary-runtime/\${OMO_AI_VERSION}/${KEYCHAIN_HELPER_PAYLOAD}"`)
    expect(smoke).toContain('bun script/keychain-helper-release.ts verify "$helper"')
    expect(smoke).toMatch(/darwin-arm64\)\n(?:.*\n)*?\s+assert_first_run_provisioned\n\s+assert_keychain_helper_provisioned\n/)
  })
})

describe("omo-ai keychain helper in publish-main (#11262)", () => {
  const steps = jobSteps(publishWorkflow, "publish-main")
  const notPublished = "needs.release-metadata.outputs.already_published != 'true'"

  test("stages the helper between the payload build and the release-mode payload verify", () => {
    const build = stepAt(steps, "Build omo-ai payload")
    const download = stepAt(steps, "Download keychain helper")
    const stage = stepAt(steps, "Stage keychain helper into the omo-ai payload")
    const restore = stepAt(steps, "Restore keychain helper from the existing release")
    const verify = stepAt(steps, "Verify omo-ai payload")

    expect([build.index, download.index, stage.index, restore.index, verify.index]).toEqual(
      [build.index, build.index + 1, build.index + 2, build.index + 3, build.index + 4],
    )
    expect(download.value.if).toBe(`inputs.skip_platform != true && inputs.lazycodex_only != true && ${notPublished}`)
    expect(stage.value.if).toBe(download.value.if)
    expect(restore.value.if).toBe(`inputs.skip_platform == true && inputs.lazycodex_only != true && ${notPublished}`)
    expect(restore.value.env).toEqual({ VERSION: "${{ needs.release-metadata.outputs.version }}", GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}" })
    expect(verify.value.run).toBe("node script/verify-omo-ai-payload.mjs --release")
  })

  test.skipIf(process.platform === "win32")("extracts this run's helper with its execute bit", () => {
    withRoot("omo-keychain-omo-ai-", (root) => {
      helperTarball(root)
      const script = runBlock(publishWorkflow, "      - name: Stage keychain helper into the omo-ai payload\n", "      - name: Restore keychain helper from the existing release\n")
      const result = bash(script, root, {})
      expect(result.status, String(result.stderr)).toBe(0)
      expect(mode(join(root, KEYCHAIN_HELPER_SOURCE))).toBe(0o755)
    })
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  describe("skip_platform restores the release asset by digest and fails closed", () => {
    const script = runBlock(publishWorkflow, "      - name: Restore keychain helper from the existing release\n", "      - name: Verify omo-ai payload\n")
    const restore = (assets: Readonly<Record<string, string>>, sums: string) => {
      const root = mkdtempSync(join(tmpdir(), "omo-keychain-restore-"))
      const release = join(root, "release")
      mkdirSync(release)
      for (const [name, bytes] of Object.entries(assets)) writeFileSync(join(release, name), bytes)
      writeFileSync(join(release, "SHA256SUMS"), sums)
      const bin = join(root, "fake-bin")
      mkdirSync(bin)
      writeFileSync(join(bin, "gh"), [
        "#!/bin/bash",
        '[ "$1" = release ] && [ "$2" = download ] || exit 1',
        'shift 3; dir=""; patterns=()',
        'while [ "$#" -gt 0 ]; do case "$1" in --pattern) patterns+=("$2"); shift 2 ;; --dir) dir="$2"; shift 2 ;; *) exit 2 ;; esac; done',
        'found=0; for p in "${patterns[@]}"; do [ -f "$RELEASE_DIR/$p" ] && cp "$RELEASE_DIR/$p" "$dir/" && found=1; done',
        '[ "$found" = 1 ]',
        "",
      ].join("\n"))
      chmodSync(join(bin, "gh"), 0o755)
      if (spawnSync("bash", ["-c", "command -v shasum"], { timeout: SUBPROCESS_SPAWN_TIMEOUT_MS }).status !== 0) {
        writeFileSync(join(bin, "shasum"), '#!/bin/bash\n[ "$1" = -a ] && [ "$2" = 256 ] || exit 2\nshift 2\nexec sha256sum "$@"\n')
        chmodSync(join(bin, "shasum"), 0o755)
      }
      const result = bash(script, root, { PATH: `${bin}:${process.env.PATH ?? ""}`, RELEASE_DIR: release, VERSION: "5.0.0" })
      return { root, result, installed: join(root, KEYCHAIN_HELPER_SOURCE) }
    }
    const line = (name: string, bytes: string): string => `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`

    test.skipIf(process.platform === "win32")("installs a digest-matching asset with mode 0755", () => {
      const { root, result, installed } = restore({ [KEYCHAIN_HELPER_RELEASE_ASSET]: HELPER_BYTES }, line("omo-linux-x64", "x") + line(KEYCHAIN_HELPER_RELEASE_ASSET, HELPER_BYTES))
      try {
        expect(result.status, String(result.stderr)).toBe(0)
        expect(mode(installed)).toBe(0o755)
        expect(readFileSync(installed, "utf8")).toBe(HELPER_BYTES)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }, SUBPROCESS_TEST_TIMEOUT_MS)

    for (const [label, assets, sums] of [
      ["a tampered asset", { [KEYCHAIN_HELPER_RELEASE_ASSET]: "tampered\n" }, line(KEYCHAIN_HELPER_RELEASE_ASSET, HELPER_BYTES)],
      ["a release without the asset", {}, line("omo-linux-x64", "x")],
      ["an asset SHA256SUMS does not list", { [KEYCHAIN_HELPER_RELEASE_ASSET]: HELPER_BYTES }, line("omo-linux-x64", "x")],
    ] as const) {
      test(`refuses ${label} and installs nothing`, () => {
        const { root, result, installed } = restore(assets, sums)
        try {
          expect(result.status).not.toBe(0)
          expect(existsSync(installed)).toBe(false)
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      }, SUBPROCESS_TEST_TIMEOUT_MS)
    }
  })

  test("the release job uploads, restores and checksums the helper with the launchers", () => {
    const steps = jobSteps(publishWorkflow, "release")
    expect(stepAt(steps, "Download release-binary artifacts").value.with).toMatchObject({ pattern: "release-binary-*", path: ".omo/release-binaries" })
    const upload = stepAt(steps, "Upload release assets").value.run ?? ""
    expect(upload).toContain(`gh release download "v\${VERSION}" --pattern ${KEYCHAIN_HELPER_RELEASE_ASSET} --dir .omo/release-binaries`)
    expect(upload).toContain("(cd .omo/release-binaries && shasum -a 256 omo-* > SHA256SUMS)")
    expect(upload).toContain('gh release upload "v${VERSION}" .omo/release-binaries/omo-*')
  })
})
