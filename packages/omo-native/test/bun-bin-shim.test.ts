import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { ensureBunBinShim } from "../bin/lib/bun-bin-shim.js"
import { baseInput, bunTreePackage, legacyShim, NON_POSIX_HOST, POSIX_HOME, recorder, stockLinkTarget } from "./bun-bin-shim.test-support"

describe.skipIf(NON_POSIX_HOST)("Bun owns its global bin links", () => {
  const scriptPath = bunTreePackage(join(POSIX_HOME, ".bun"))

  for (const versions of [{}, { bun: "1.4.2" }]) {
    test(`#given runtime ${JSON.stringify(versions)} #then preparation preserves the stock link`, () => {
      const { options, bunRootDir } = baseInput(scriptPath, { versions })
      const binPath = join(bunRootDir, "bin", "omo")
      const fs = recorder()
      fs.markLink(binPath)
      const result = ensureBunBinShim({
        ...options, ...fs, realpath: (path: string) => path === binPath ? scriptPath : path,
      })
      expect(result.action).toBe("current")
      expect(fs.lstat(binPath).isSymbolicLink()).toBe(true)
      expect(fs.renamed).toEqual([{ from: `${scriptPath}.4242.tmp`, to: scriptPath }])
      expect(fs.chmodded).toEqual([{ path: `${scriptPath}.4242.tmp`, mode: 0o755 }])
    })
  }

  test("#given a prepared entrypoint #then a later launch does not rewrite it", () => {
    const { options } = baseInput(scriptPath)
    const fs = recorder()
    ensureBunBinShim({ ...options, ...fs })
    fs.written.length = 0
    fs.renamed.length = 0
    ensureBunBinShim({ ...options, ...fs })
    expect(fs.written).toHaveLength(0)
    expect(fs.renamed).toHaveLength(0)
  })

  for (const version of ["v0", "v1"]) {
    test(`#given a marked ${version} wrapper #then it becomes a relative link`, () => {
      const { options, bunRootDir, bunPath } = baseInput(scriptPath)
      const binPath = join(bunRootDir, "bin", "omo")
      const fs = recorder({ [binPath]: legacyShim(scriptPath, bunPath).replace("shim v1", `shim ${version}`) })
      const result = ensureBunBinShim({ ...options, ...fs })
      expect(result.action).toBe("repaired")
      expect(fs.linked).toEqual([{ target: stockLinkTarget(), path: `${binPath}.4242.tmp` }])
      expect(fs.lstat(binPath).isSymbolicLink()).toBe(true)
    })
  }

  test("#given a foreign symlink #then it is never replaced", () => {
    const { options, bunRootDir } = baseInput(scriptPath)
    const binPath = join(bunRootDir, "bin", "omo")
    const fs = recorder()
    fs.markLink(binPath)
    const result = ensureBunBinShim({
      ...options, ...fs,
      realpath: (path: string) => path === binPath ? "/other/omo.js" : path,
    })
    expect(result.action).toBe("foreign-link")
    expect(fs.renamed.some(entry => entry.to === binPath)).toBe(false)
  })

  for (const source of [
    "#!/bin/sh\nexec something-else\n",
    "#!/bin/sh\n# mentions omo-ai bun launcher shim\nexec something-else\n",
    legacyShim("/other/omo.js", "/other/bun"),
  ]) {
    test(`#given foreign file ${JSON.stringify(source)} #then it is preserved`, () => {
      const { options, bunRootDir } = baseInput(scriptPath)
      const binPath = join(bunRootDir, "bin", "omo")
      const fs = recorder({ [binPath]: source })
      const result = ensureBunBinShim({ ...options, ...fs })
      expect(result.action).toBe("foreign-file")
      expect(fs.readFile(binPath)).toBe(source)
      expect(fs.linked).toHaveLength(0)
    })
  }

  test("#given an absent bin #then preparation does not create it", () => {
    const { options } = baseInput(scriptPath)
    const fs = recorder()
    const result = ensureBunBinShim({ ...options, ...fs })
    expect(result.action).toBe("absent-bin")
    expect(fs.linked).toHaveLength(0)
  })

  test("#given an entrypoint write failure #then the legacy launcher is preserved", () => {
    const { options, bunRootDir, bunPath } = baseInput(scriptPath)
    const binPath = join(bunRootDir, "bin", "omo")
    const old = legacyShim(scriptPath, bunPath)
    const fs = recorder({ [binPath]: old })
    const result = ensureBunBinShim({
      ...options, ...fs, write: () => { throw new Error("EACCES: permission denied") },
    })
    expect(result).toMatchObject({ action: "failed", error: "EACCES: permission denied", entries: [] })
    expect(fs.readFile(binPath)).toBe(old)
    expect(fs.linked).toHaveLength(0)
  })

  test("#given a rename failure #then debug reports it and the temporary file is removed", () => {
    const { options } = baseInput(scriptPath, { env: { OMO_DEBUG: "1" } })
    const fs = recorder()
    const warnings: string[] = []
    const result = ensureBunBinShim({
      ...options, ...fs,
      rename: () => { throw new Error("EROFS: read-only file system") },
      warn: (message: string) => warnings.push(message),
    })
    expect(result.action).toBe("failed")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(scriptPath)
    expect(warnings[0]).toContain("EROFS")
    expect(fs.removed).toContain(`${scriptPath}.4242.tmp`)
  })
})

describe("Bun entrypoint preparation boundaries", () => {
  for (const [context, expected] of [
    [{ platform: "win32" }, "skipped-platform"],
    [{ scriptPath: "/usr/local/lib/node_modules/omo-ai/bin/omo.js" }, "skipped-install"],
    [{ exists: () => false }, "skipped-no-bun"],
  ] as const) {
    test(`#given ${expected} #then files remain untouched`, () => {
      const { options } = baseInput(bunTreePackage(join(POSIX_HOME, ".bun")), context)
      const fs = recorder()
      const result = ensureBunBinShim({ ...options, ...fs })
      expect(result.action).toBe(expected)
      expect(result.entries).toEqual([])
      expect(fs.written).toHaveLength(0)
      expect(fs.linked).toHaveLength(0)
    })
  }
})
