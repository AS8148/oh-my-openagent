// Contract: the vendored store stays code-identical to the pinned senpi store (omo-opencode cannot depend on senpi).
import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const repoRoot = join(import.meta.dir, "../../../..")
const vendoredPath = join(import.meta.dir, "env-grants-store.ts")
const senpiStorePath = join(repoRoot, "node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/mcp/env-grants-store.js")
/** The first senpi release that ships the store (senpi#3818, c6317f5971). */
const FIRST_SENPI_WITH_STORE = "2026.10.23-1"

function normalizedCode(source: string, loader: "ts" | "js"): string {
  const javascript = new Bun.Transpiler({ loader, target: "node" }).transformSync(source)
  return new Bun.Transpiler({ loader: "js", target: "node", minifyWhitespace: true })
    .transformSync(javascript)
    .replace(/\/\/# sourceMappingURL=.*$/m, "")
}

function pinnedSenpiVersion(): string {
  const manifest: unknown = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))
  const pins = typeof manifest === "object" && manifest !== null && "devDependencies" in manifest ? manifest.devDependencies : undefined
  const version = typeof pins === "object" && pins !== null && "@code-yeongyu/senpi" in pins ? pins["@code-yeongyu/senpi"] : undefined
  if (typeof version !== "string") throw new Error("root package.json does not pin @code-yeongyu/senpi")
  return version
}

test("vendored env-grants-store has the same code as the pinned senpi store", () => {
  if (!existsSync(senpiStorePath)) {
    // A pin at or after the first shipping release without the file means the store moved: fail, never skip.
    expect(pinnedSenpiVersion() < FIRST_SENPI_WITH_STORE).toBe(true)
    return
  }
  const vendored = normalizedCode(readFileSync(vendoredPath, "utf8"), "ts")
  const senpi = normalizedCode(readFileSync(senpiStorePath, "utf8"), "js")
  expect(vendored).toBe(senpi)
})
