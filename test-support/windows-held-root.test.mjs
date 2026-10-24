import { describe, expect, test } from "bun:test"
import { diagnoseHeldTestRoot } from "./windows-held-root.mjs"

describe("Windows held-root diagnostic", () => {
  test("#given another platform #when diagnosed #then no process is launched", () => {
    const result = diagnoseHeldTestRoot("/synthetic/root", {
      platform: "darwin",
      run: () => { throw new Error("must not spawn") },
    })
    expect(result).toEqual({ holders: [], diagnosticErrors: [] })
  })

  test("#given Windows holders #when queried #then pid image and parent pid are retained", () => {
    const root = "C:\\temp\\held root"
    const expected = { holders: [{ pid: 31, image: "node.exe", parentPid: 30 }], diagnosticErrors: [] }
    const calls = []
    const result = diagnoseHeldTestRoot(root, {
      platform: "win32",
      run: (command, args, options) => {
        calls.push({ command, args, options })
        return { status: 0, stdout: JSON.stringify(expected), stderr: "" }
      },
    })
    expect(result).toEqual(expected)
    expect(calls).toHaveLength(1)
    expect(calls[0].command).toMatch(/powershell\.exe$/)
    expect(calls[0].args.slice(-2)).toEqual(["-Root", root])
    expect(calls[0].args).toContain("-NonInteractive")
    expect(calls[0].args).toContain("-File")
    expect(calls[0].options).toEqual({ encoding: "utf8", windowsHide: true })
  })

  for (const [name, run] of [
    ["spawn error", () => ({ error: new Error("not available") })],
    ["nonzero exit", () => ({ status: 1, stdout: "", stderr: "query failed" })],
    ["invalid JSON", () => ({ status: 0, stdout: "not JSON" })],
    ["invalid holder", () => ({ status: 0, stdout: JSON.stringify({ holders: [{ pid: "31" }], diagnosticErrors: [] }) })],
    ["thrown error", () => { throw new Error("spawn threw") }],
  ]) {
    test(`#given ${name} #when diagnosed #then it records the failure without throwing`, () => {
      const result = diagnoseHeldTestRoot("C:\\temp\\held", { platform: "win32", run })
      expect(result.holders).toEqual([])
      expect(result.diagnosticErrors).toHaveLength(1)
    })
  }

  test("#given a partial diagnostic #when a holder is found but parent lookup fails #then both results are recorded", () => {
    const expected = {
      holders: [{ pid: 31, image: "node.exe", parentPid: null }],
      diagnosticErrors: ["process exited before parent lookup"],
    }
    expect(diagnoseHeldTestRoot("C:\\temp\\held", {
      platform: "win32",
      run: () => ({ status: 0, stdout: JSON.stringify(expected) }),
    })).toEqual(expected)
  })
})
