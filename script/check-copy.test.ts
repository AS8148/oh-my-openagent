import { describe, expect, test } from "bun:test"
import { findEmDashCopy, isProductSource } from "./check-copy"

describe("no-em-dash-copy", () => {
  const path = "packages/example/src/copy.tsx"

  test.each([
    ['const label = "Refresh failed \u2014 retry";'],
    ["const label = `${name} \u2014 ${kind}`;"],
    ["const label = `Before \u2014 ${name}`;"],
    ["const label = `${name} \u2014`;"],
    ["const label = `Refresh \u2014 retry`;"],
    ["const node = <p>Run a prompt \u2014 on an interval</p>;"],
    ['const label = "Refresh \\u2014 retry";'],
    ["const label = `Refresh \\u{2014} retry`;"],
  ])("reports product copy: %s", (content) => {
    expect(findEmDashCopy(content, path)).toHaveLength(1)
  })

  test("allows comments, regex literals, hyphens and en dashes", () => {
    const content = '// Issue \u2014 Browser\nconst title = /[\u2013\u2014-]/u;\nconst label = "Refresh - retry 1\u20132";'
    expect(findEmDashCopy(content, path)).toEqual([])
  })

  test("reports each matching node at its source position", () => {
    expect(findEmDashCopy('const a = "-";\nconst b = "\u2014";', path)).toEqual([{ line: 2, column: 11 }])
  })

  test.each([
    "packages/example/src/copy.test.ts",
    "packages/example/src/copy.spec.tsx",
    "packages/example/src/__tests__/copy.ts",
    "packages/example/src/tests/copy.ts",
    "packages/example/src/testkit/copy.ts",
    "packages/example/src/fixtures/copy.ts",
    "packages/example/src/testUtils/copy.ts",
    "packages/example/src/testUtils.ts",
    "packages/example/src/_generated/copy.ts",
    "packages/example/src/copy.gen.ts",
    "packages/example/src/copy.generated.ts",
    "packages/example/src/vendor/copy.ts",
    "packages/example/plugin/dist/copy.js",
    "packages/shared-skills/upstreams/copy.ts",
    "packages/lsp-daemon/src/proxy.ts",
    "packages/lsp-tools-mcp/src/index.ts",
    "packages/omo-senpi/plugin/extensions/omo.js",
    "packages/omo-senpi/plugin/runtime/agent-toolkit-sdk/sdk.js",
    "packages/omo-senpi/src/components/ultrawork/generated-directive.ts",
    "packages/omo-codex/plugin/components/ultrawork/src/directive-content.ts",
    "docs/copy.md",
    "script/copy.ts",
  ])("exempts %s", (filename) => {
    expect(isProductSource(filename)).toBe(false)
    expect(findEmDashCopy('const label = "\u2014";', filename)).toEqual([])
  })

  test.each([
    "src/copy.ts",
    "app/copy.tsx",
    "lib/copy.js",
    "workers/copy.mts",
    "bin/oh-my-opencode.js",
    "packages/omo-native/bin/omo.js",
    "packages/omo-opencode/src/testing/create-plugin-module.ts",
    "packages/example/src/copy.ts",
    "packages/web/app/page.tsx",
    "packages/web/components/copy.tsx",
    "packages/web/lib/copy.mjs",
    "packages/example/plugin/components/copy.ts",
  ])("checks %s", (filename) => {
    expect(isProductSource(filename)).toBe(true)
  })
})
