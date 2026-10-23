// Preloaded into every process of the bundle recipe by bundle-inputs.mjs (node --import, bun --preload).
// Appends one JSON line per path the process reads, lists or loads to OMO_BUNDLE_INPUTS_TRACE, and
// every input the bundler reports: a spawned `bun build` gets a --metafile when it has none, and
// Bun.build runs with metafile: true. Nothing here changes what the recipe builds.
import fs from "node:fs"
import childProcess from "node:child_process"
import module from "node:module"
import { basename, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const log = process.env.OMO_BUNDLE_INPUTS_TRACE
const scratch = process.env.OMO_BUNDLE_INPUTS_TMP
const appendLine = fs.appendFileSync.bind(fs)
const readText = fs.readFileSync.bind(fs)
const exists = fs.existsSync.bind(fs)

const toPath = (value) => {
  if (value instanceof URL) return fileURLToPath(value)
  if (typeof value === "string") return value
  if (Buffer.isBuffer(value)) return value.toString()
  return undefined
}

const record = (kind, value, cwd = process.cwd()) => {
  const path = toPath(value)
  if (log === undefined || path === undefined) return
  appendLine(log, `${JSON.stringify({ kind, path: isAbsolute(path) ? path : resolve(cwd, path) })}\n`)
}

const wrap = (target, name, kind) => {
  const original = target[name]
  if (typeof original !== "function") return
  target[name] = function traced(path, ...rest) {
    record(kind, path)
    return original.call(this, path, ...rest)
  }
}

for (const name of ["readFile", "readFileSync", "createReadStream", "copyFile", "copyFileSync", "cp", "cpSync"]) wrap(fs, name, "read")
for (const name of ["readdir", "readdirSync", "opendir", "opendirSync"]) wrap(fs, name, "list")
for (const name of ["readFile", "copyFile", "cp"]) wrap(fs.promises, name, "read")
for (const name of ["readdir", "opendir"]) wrap(fs.promises, name, "list")

let metafiles = 0
const isBunBuild = (command, args) => /^bun(?:\.exe)?$/.test(basename(String(command))) && Array.isArray(args) && args[0] === "build"
const recordMetafile = (metafile, cwd) => {
  const path = isAbsolute(metafile) ? metafile : resolve(cwd, metafile)
  if (!exists(path)) return record("missing-metafile", path)
  for (const input of Object.keys(JSON.parse(readText(path, "utf8")).inputs ?? {})) record("bundle", input, cwd)
}
const spawnSync = childProcess.spawnSync
childProcess.spawnSync = function tracedSpawnSync(command, args, options) {
  if (!isBunBuild(command, args)) return spawnSync.call(this, command, args, options)
  const given = args.find((arg) => typeof arg === "string" && arg.startsWith("--metafile="))
  const metafile = given?.slice("--metafile=".length) ?? join(scratch ?? process.cwd(), `meta-${process.pid}-${metafiles++}.json`)
  const result = spawnSync.call(this, command, given === undefined ? [...args, `--metafile=${metafile}`] : args, options)
  if (result.status === 0) recordMetafile(metafile, options?.cwd ?? process.cwd())
  return result
}
module.syncBuiltinESMExports()

module.registerHooks?.({
  load(url, context, next) {
    if (url.startsWith("file:")) record("module", new URL(url))
    return next(url, context)
  },
})
if (process.argv[1] !== undefined && exists(process.argv[1])) record("module", process.argv[1])

if (typeof Bun !== "undefined") {
  const build = Bun.build
  Bun.build = async (config) => {
    const result = await build({ ...config, metafile: true })
    if (result.metafile?.inputs === undefined) record("missing-metafile", "Bun.build")
    else for (const input of Object.keys(result.metafile.inputs)) record("bundle", input)
    return result
  }
}
