import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { BUNDLE_INPUTS_PATH, mapFromTrace, renderBundleInputs } from "./bundle-inputs.mjs"

const root = "/repo"
const existing = new Set([
  "/repo/package.json",
  "/repo/bun.lock",
  "/repo/packages/memory-core/package.json",
  "/repo/packages/memory-core/tsconfig.json",
  "/repo/packages/omo-senpi/package.json",
])
const deps = { repoRoot: root, exists: (path) => existing.has(path), realpath: (path) => path }
const row = (kind, path) => ({ kind, path })

describe("mapFromTrace", () => {
  test("keeps every traced repo file and adds the manifests that steer resolution", () => {
    const map = mapFromTrace([row("bundle", "/repo/packages/memory-core/src/a.ts"), row("read", "/repo/packages/omo-senpi/plugin/scripts/build-artifact.mjs")], deps)
    expect(map.files).toEqual([
      "package.json",
      "packages/memory-core/package.json",
      "packages/memory-core/src/a.ts",
      "packages/memory-core/tsconfig.json",
      "packages/omo-senpi/package.json",
      "packages/omo-senpi/plugin/scripts/build-artifact.mjs",
    ])
  })

  test("collapses dependency files to the lockfile and drops paths outside the repo", () => {
    const map = mapFromTrace([row("bundle", "/repo/node_modules/zod/v4/index.js"), row("read", "/tmp/omo-senpi-check/omo.js"), row("read", "/repo/.git/HEAD")], deps)
    expect(map.files).toEqual(["bun.lock", "package.json"])
  })

  test("records listed directories separately, so any file added under them counts", () => {
    const map = mapFromTrace([row("list", "/repo/packages/omo-codex/src/install"), row("list", "/elsewhere")], deps)
    expect(map.directories).toEqual(["packages/omo-codex/src/install"])
  })

  test("never lists the map itself as an input", () => {
    const map = mapFromTrace([row("read", join(root, BUNDLE_INPUTS_PATH))], deps)
    expect(map.files).not.toContain(BUNDLE_INPUTS_PATH)
  })

  test("a step whose bundler metafile went missing fails the trace instead of under-reporting", () => {
    expect(() => mapFromTrace([row("missing-metafile", "/repo/x.json")], deps)).toThrow("metafile")
  })
})

describe("the committed map", () => {
  const committed = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "..", BUNDLE_INPUTS_PATH), "utf8"))

  test("is rendered in canonical form", () => {
    expect(readFileSync(join(import.meta.dir, "..", "..", "..", "..", BUNDLE_INPUTS_PATH), "utf8")).toBe(renderBundleInputs(committed))
  })

  // The bundle marker hashes the build scripts next to the sources (build-artifact.mjs digestBuildSources),
  // so a comment-only edit to either changes every header: both must be inputs.
  test("covers the files every bundle header hashes", () => {
    for (const path of [
      "packages/omo-senpi/plugin/scripts/build-artifact.mjs",
      "packages/omo-senpi/plugin/scripts/build-extension-core.mjs",
      "packages/omo-senpi/src/extension/bundled-index.ts",
      "packages/omo-senpi/src/install/cli-local.ts",
      "script/build-codex-install.ts",
    ]) expect(committed.files).toContain(path)
  })
})
