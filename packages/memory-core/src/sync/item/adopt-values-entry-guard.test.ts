import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"

// Architecture contract (#10321): captureOnDevice (device-capture.ts) is the only way production
// code builds a capture update. withRegisterValues composes an update with no receipt, no replay
// guard and no device check, so a production import anywhere else reopens the bug class #10206's
// review found (a replay from a stale baseline duplicated a line). Tests may still compose plans
// on plain docs through it.

const PACKAGES_ROOT = path.resolve(import.meta.dir, "../../../..")
const ENTRY_POINT = path.join(import.meta.dir, "device-capture.ts")
const SKIPPED_DIRS = new Set(["node_modules", "dist"])
const SOURCE_FILE = /\.(?:[mc]?ts|tsx)$/
const STATIC_FORM = /\b(?:import|export)\s+((?:(?!\b(?:import|export|from)\b)[^;])*?)\s*\bfrom\s*["'][^"']*\badopt-values(?:\.[mc]?[jt]s)?["']/g
const DYNAMIC_FORM = /\b(?:import|require)\s*\(\s*["'][^"']*\badopt-values(?:\.[mc]?[jt]s)?["']/

function reachesWithRegisterValues(source: string): boolean {
  if (DYNAMIC_FORM.test(source)) return true
  for (const match of source.matchAll(STATIC_FORM)) {
    const clause = match[1] ?? ""
    if (/\bwithRegisterValues\b/.test(clause) || clause.includes("*")) return true
  }
  return false
}

function isTestModule(name: string): boolean {
  return /\.test\.[mc]?tsx?$/.test(name) || name.includes("test-support")
}

function productionSources(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) continue
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...productionSources(entryPath))
    else if (SOURCE_FILE.test(entry.name) && !isTestModule(entry.name)) files.push(entryPath)
  }
  return files
}

describe("withRegisterValues is reachable only from the capture entry point", () => {
  test("the detector catches every import form that reaches it", () => {
    const reaching = [
      'import { withRegisterValues } from "./adopt-values"',
      'import { registerValuesWritten, withRegisterValues as compose } from "../item/adopt-values"',
      'import {\n  activeRegisters,\n  withRegisterValues,\n} from "../sync/item/adopt-values.ts"',
      'import * as values from "./adopt-values"',
      'export { withRegisterValues } from "./adopt-values"',
      'export * from "./adopt-values"',
      'const values = await import("./adopt-values")',
      'const values = require("../item/adopt-values.js")',
    ]
    for (const sample of reaching) expect(reachesWithRegisterValues(sample), sample).toBe(true)
    const allowed = [
      'import type { RegisterValue } from "./adopt-values"',
      'export { activeRegisters, registerValuesWritten, type RegisterValue } from "./adopt-values"',
      'import { withRegisterValues } from "./other-module"',
      'import { x } from "./adopt-values-extra"',
      'import { withRegisterValues } from "./other-module"\nimport { activeRegisters } from "./adopt-values"',
    ]
    for (const sample of allowed) expect(reachesWithRegisterValues(sample), sample).toBe(false)
  })

  test("no production module outside device-capture.ts imports it", () => {
    const offenders = productionSources(PACKAGES_ROOT)
      .filter((file) => file !== ENTRY_POINT)
      .filter((file) => {
        const source = readFileSync(file, "utf8")
        return source.includes("adopt-values") && reachesWithRegisterValues(source)
      })
      .map((file) => path.relative(PACKAGES_ROOT, file))
    expect(offenders).toEqual([])
  })
})
