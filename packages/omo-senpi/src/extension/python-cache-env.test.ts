import { afterAll, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { applyPythonCacheDefault } from "./python-cache-env"

const python = process.platform === "win32" ? "python" : "python3"
const workRoot = mkdtempSync(join(tmpdir(), "omo-pycache-env-"))

afterAll(() => {
  rmSync(workRoot, { recursive: true, force: true })
})

function listPyc(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true, encoding: "utf8" }).filter((path) => path.endsWith(".pyc"))
}

describe("applyPythonCacheDefault (#11373)", () => {
  it("#given neither variable is set #when applied #then bytecode goes to an OmO cache folder for each platform", () => {
    const cases = [
      { platform: "darwin", env: {}, expected: join("/home/u", "Library", "Caches", "omo", "pycache") },
      { platform: "linux", env: {}, expected: join("/home/u", ".cache", "omo", "pycache") },
      { platform: "linux", env: { XDG_CACHE_HOME: "/xdg" }, expected: join("/xdg", "omo", "pycache") },
      { platform: "linux", env: { XDG_CACHE_HOME: "relative" }, expected: join("/home/u", ".cache", "omo", "pycache") },
      { platform: "win32", env: { LOCALAPPDATA: "/lad" }, expected: join("/lad", "omo", "pycache") },
    ] as const
    for (const testCase of cases) {
      // given
      const env: NodeJS.ProcessEnv = { ...testCase.env }

      // when
      applyPythonCacheDefault(env, testCase.platform, "/home/u")

      // then
      expect(env.PYTHONPYCACHEPREFIX).toBe(testCase.expected)
      expect(env.PYTHONDONTWRITEBYTECODE).toBeUndefined()
    }
  })

  it("#given the user set either variable, even empty #when applied #then both are left exactly as they were", () => {
    const userChoices: NodeJS.ProcessEnv[] = [
      { PYTHONDONTWRITEBYTECODE: "1" },
      { PYTHONDONTWRITEBYTECODE: "" },
      { PYTHONPYCACHEPREFIX: "/mine" },
      { PYTHONPYCACHEPREFIX: "" },
    ]
    for (const choice of userChoices) {
      // given
      const env: NodeJS.ProcessEnv = { ...choice }

      // when
      applyPythonCacheDefault(env, "linux", "/home/u")

      // then
      expect(env).toEqual(choice)
    }
  })

  it("#given a user project #when Python runs twice under the default #then bytecode is cached in the prefix and reused, never written in the project", async () => {
    // given
    const project = join(workRoot, "project")
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, "helper.py"), "VALUE = 7\n")
    writeFileSync(join(project, "main.py"), "import helper\nprint(helper.VALUE)\n")
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env.PYTHONDONTWRITEBYTECODE
    delete env.PYTHONPYCACHEPREFIX
    applyPythonCacheDefault(env, process.platform, join(workRoot, "home"))
    const prefix = env.PYTHONPYCACHEPREFIX ?? ""
    const run = async () => {
      const child = Bun.spawn([python, "main.py"], { cwd: project, env, stdout: "pipe", stderr: "pipe", timeout: 30_000 })
      const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
      expect(exitCode).toBe(0)
      expect(stdout.trim()).toBe("7")
    }

    // when
    await run()
    const cached = listPyc(prefix)
    const firstWrite = cached.map((path) => statSync(join(prefix, path)).mtimeMs)
    await run()

    // then
    expect(cached.some((path) => path.includes("helper."))).toBe(true)
    expect(cached.map((path) => statSync(join(prefix, path)).mtimeMs)).toEqual(firstWrite)
    expect(listPyc(project)).toEqual([])
  }, 60_000)
})
