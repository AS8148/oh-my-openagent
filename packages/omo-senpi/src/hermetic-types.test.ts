import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "bun:test"

type JsonObject = Record<string, unknown>

const packageRoot = new URL("../", import.meta.url)
const repoRoot = new URL("../../../", import.meta.url)

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

  test("#given a checkout anywhere on disk #when the typecheck program is listed #then every @types/node file comes from inside the repository", async () => {
    const root = fileURLToPath(repoRoot)
    const proc = Bun.spawn([`${root}node_modules/.bin/tsgo`, "-p", fileURLToPath(new URL("tsconfig.json", packageRoot)), "--listFilesOnly"], { stdout: "pipe", stderr: "pipe" })
    const [listing, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    const nodeTypes = listing.split("\n").filter((file) => file.includes("/@types/node/"))

    expect(exitCode).toBe(0)
    expect(nodeTypes.length).toBeGreaterThan(0)
    expect(nodeTypes.filter((file) => !file.startsWith(root))).toEqual([])
  }, 60_000)

  test("#given the tsconfig #when its type roots are read #then every root is inside the package's own node_modules", async () => {
    const tsconfig = await readJsonObject(new URL("tsconfig.json", packageRoot))
    const options = tsconfig.compilerOptions as JsonObject
    const typeRoots = options.typeRoots as unknown

    expect(Array.isArray(typeRoots) && typeRoots.length > 0).toBe(true)
    for (const root of typeRoots as string[]) expect(root.startsWith("./node_modules")).toBe(true)
    expect(options.types).toEqual(["bun-types", "node"])
  })
})
