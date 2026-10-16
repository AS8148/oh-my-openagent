import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, test } from "bun:test"

type JsonObject = Record<string, unknown>

const packageRoot = new URL("../", import.meta.url)
const repoRoot = new URL("../../../", import.meta.url)
const packageDir = fileURLToPath(packageRoot)
const tsgo = fileURLToPath(new URL("node_modules/.bin/tsgo", repoRoot))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "omo-hermetic-types-")))

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

async function readJsonObject(url: URL): Promise<JsonObject> {
  const parsed: unknown = JSON.parse(await readFile(url, "utf8"))
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${url.pathname} must contain a JSON object`)
  return parsed as JsonObject
}

function stringRecord(record: JsonObject, key: string): Record<string, string> {
  const value = record[key]
  if (typeof value !== "object" || value === null) throw new Error(`${key} must be an object`)
  return value as Record<string, string>
}

function isInsidePackageNodeModules(typeRoot: string): boolean {
  const target = resolve(packageDir, typeRoot)
  const nodeModules = resolve(packageDir, "node_modules")
  return target === nodeModules || target.startsWith(`${nodeModules}${sep}`)
}

async function listNodeTypesUnderDecoyParent(name: string, linkPackageNodeTypes: boolean): Promise<{ decoy: string; nodeTypes: string[] }> {
  const decoy = join(scratch, name)
  const project = join(decoy, "project")
  mkdirSync(join(decoy, "node_modules", "@types", "node"), { recursive: true })
  writeFileSync(join(decoy, "node_modules", "@types", "node", "package.json"), JSON.stringify({ name: "@types/node", version: "0.0.0-decoy", types: "index.d.ts" }))
  writeFileSync(join(decoy, "node_modules", "@types", "node", "index.d.ts"), 'declare module "child_process" { interface ForkOptions { cwd?: string } }\n')
  mkdirSync(join(project, "src"), { recursive: true })
  mkdirSync(join(project, "node_modules", "@types"), { recursive: true })
  writeFileSync(join(project, "src", "index.ts"), "export const probe = 1\n")
  symlinkSync(realpathSync(join(packageDir, "node_modules", "bun-types")), join(project, "node_modules", "bun-types"))
  if (linkPackageNodeTypes) symlinkSync(realpathSync(join(packageDir, "node_modules", "@types", "node")), join(project, "node_modules", "@types", "node"))
  const tsconfig = await readJsonObject(new URL("tsconfig.json", packageRoot))
  writeFileSync(join(project, "tsconfig.json"), JSON.stringify({ compilerOptions: tsconfig.compilerOptions, include: ["src/**/*"] }))

  const proc = Bun.spawn([tsgo, "-p", join(project, "tsconfig.json"), "--listFilesOnly"], { stdout: "pipe", stderr: "pipe" })
  const [listing] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { decoy: join(decoy, "node_modules"), nodeTypes: listing.split("\n").filter((file) => file.includes("/@types/node/")) }
}

// A frozen install may leave the root's overridden @types/node out of node_modules, and tsc/tsgo then walks up to a
// parent folder's @types (a different version), so the same commit typechecked differently by checkout location (#10320).
describe("omo-senpi typecheck resolves only its own type packages", () => {
  test("#given the package manifest #when its type packages are read #then @types/node and bun-types are declared at the root's pinned versions", async () => {
    const pkg = await readJsonObject(new URL("package.json", packageRoot))
    const root = await readJsonObject(new URL("package.json", repoRoot))
    const dev = stringRecord(pkg, "devDependencies")

    expect(dev["@types/node"]).toBe(stringRecord(root, "overrides")["@types/node"])
    expect(dev["bun-types"]).toBe(stringRecord(root, "devDependencies")["bun-types"])
  })

  test("#given a decoy @types/node in a parent folder and the package's own install #when the program is listed #then @types/node comes only from the package's install", async () => {
    const { decoy, nodeTypes } = await listNodeTypesUnderDecoyParent("installed", true)

    expect(nodeTypes.length).toBeGreaterThan(0)
    expect(nodeTypes.filter((file) => file.startsWith(decoy))).toEqual([])
  }, 60_000)

  test("#given a decoy @types/node in a parent folder and no local @types/node #when the program is listed #then the decoy is still never loaded", async () => {
    const { decoy, nodeTypes } = await listNodeTypesUnderDecoyParent("missing-install", false)

    expect(nodeTypes.filter((file) => file.startsWith(decoy))).toEqual([])
  }, 60_000)

  test.each([
    ["./node_modules/@types", true],
    ["./node_modules", true],
    ["./node_modules/../..", false],
    ["../../node_modules/@types", false],
  ])("#given the type root %s #when it is resolved against the package #then package-local is %p", (typeRoot, expected) => {
    expect(isInsidePackageNodeModules(typeRoot)).toBe(expected)
  })

  test("#given the tsconfig #when its type roots are resolved #then every root is inside the package's own node_modules", async () => {
    const tsconfig = await readJsonObject(new URL("tsconfig.json", packageRoot))
    const options = tsconfig.compilerOptions as JsonObject
    const typeRoots = options.typeRoots as unknown

    expect(Array.isArray(typeRoots) && typeRoots.length > 0).toBe(true)
    expect((typeRoots as string[]).filter((root) => !isInsidePackageNodeModules(root))).toEqual([])
    expect(options.types).toEqual(["bun-types", "node"])
  })
})
