import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCreatorHandOff, DESKTOP_RUNTIME_REQUIREMENT, desktopRuntimeCandidates, HANDOFF_ENV, type HandOffRunner } from "./creator-handoff"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function runtimes(...names: string[]) {
  const root = mkdtempSync(join(tmpdir(), "creator-handoff-"))
  roots.push(root)
  return names.map(name => {
    const path = join(root, name)
    writeFileSync(path, name)
    return path
  })
}

function recorder(code: number | null = 0) {
  const runs: Array<{ path: string; args: readonly string[]; env: Record<string, string> }> = []
  const run: HandOffRunner = async (path, args, env) => {
    runs.push({ path, args, env })
    return code
  }
  return { runs, run }
}

describe("creator hand-off (#11262 addendum change 1, rows 7 and 8)", () => {
  test("#given a verified desktop runtime #when the CLI hands off #then it runs `account token` once, marked so it never hands off again", async () => {
    const [runtime] = runtimes("omo")
    const { runs, run } = recorder()
    const handOff = createCreatorHandOff({
      candidates: [runtime ?? ""],
      requirement: DESKTOP_RUNTIME_REQUIREMENT,
      env: { HOME: "/Users/someone", SECRET: "not passed" },
      check: async (_path, requirement) => requirement === DESKTOP_RUNTIME_REQUIREMENT,
      run,
      selfPath: "/other/bun",
    })
    expect(await handOff()).toBe(true)
    expect(await handOff()).toBe(true)
    expect(runs).toEqual([{ path: runtime, args: ["account", "token"], env: { [HANDOFF_ENV]: "1", HOME: "/Users/someone" } }])
  })

  test("#given a runtime failing its signature check #when handing off #then it is never run and a later verified one is", async () => {
    const [forged, real] = runtimes("forged", "real")
    const { runs, run } = recorder()
    const handOff = createCreatorHandOff({ candidates: [forged ?? "", real ?? ""], requirement: DESKTOP_RUNTIME_REQUIREMENT, env: {}, check: async path => path === real, run })
    expect(await handOff()).toBe(true)
    expect(runs.map(entry => entry.path)).toEqual([real])
  })

  test.each([
    ["the process is itself a hand-off child", { [HANDOFF_ENV]: "1" }, undefined],
    ["the only candidate is this process", {}, "SELF"],
  ] as const)("#given %s #when handing off #then nothing runs", async (_name, env, self) => {
    const [runtime] = runtimes("omo")
    const { runs, run } = recorder()
    const handOff = createCreatorHandOff({
      candidates: [runtime ?? ""],
      requirement: DESKTOP_RUNTIME_REQUIREMENT,
      env,
      check: async () => true,
      run,
      selfPath: self === "SELF" ? runtime : "/other/bun",
    })
    expect(await handOff()).toBe(false)
    expect(runs).toEqual([])
  })

  test("#given a creator that fails or is killed at the deadline #when handing off #then it reports false", async () => {
    const [runtime] = runtimes("omo")
    for (const code of [1, null]) {
      const { run } = recorder(code)
      const handOff = createCreatorHandOff({ candidates: [runtime ?? ""], requirement: DESKTOP_RUNTIME_REQUIREMENT, env: {}, check: async () => true, run, selfPath: "/x" })
      expect(await handOff()).toBe(false)
    }
  })

  test("#given no app installed #when handing off #then nothing runs", async () => {
    const { runs, run } = recorder()
    const handOff = createCreatorHandOff({ candidates: ["/nonexistent/OmO.app/omo"], requirement: DESKTOP_RUNTIME_REQUIREMENT, env: {}, check: async () => true, run })
    expect(await handOff()).toBe(false)
    expect(runs).toEqual([])
  })

  test("#given the machine #when listing app runtimes #then the system and the user Applications folders, per arch", () => {
    expect(desktopRuntimeCandidates("/Users/someone", "arm64")).toEqual([
      "/Applications/OmO.app/Contents/Resources/omo-runtime/darwin-arm64/omo",
      "/Users/someone/Applications/OmO.app/Contents/Resources/omo-runtime/darwin-arm64/omo",
    ])
    expect(desktopRuntimeCandidates("/Users/someone", "x64")[0]).toContain("darwin-x64")
  })
})
