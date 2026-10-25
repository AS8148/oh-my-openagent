import { cp, lstat, mkdtemp, readdir, rename, rm } from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"

// Codex fingerprints every plugin entry with symlink_metadata, including node_modules.
// Hooks invoke component CLIs directly; npm's .bin links are neither needed nor portable.
export async function finalizeCachedPluginPayload(pluginRoot: string): Promise<void> {
  await materializeDirectory(pluginRoot)
  const unsupported = await unsupportedEntries(pluginRoot, pluginRoot)
  if (unsupported.length > 0) {
    throw new Error(`Codex plugin contains unsupported entry types: ${unsupported.sort().join(", ")}`)
  }
}

async function materializeDirectory(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    const path = join(directory, name)
    if (basename(directory) === "node_modules" && name === ".bin") {
      await rm(path, { recursive: true, force: true })
      continue
    }
    let entry = await lstat(path)
    if (entry.isSymbolicLink()) {
      const staging = await mkdtemp(join(directory, ".omo-materialize-"))
      try {
        const copyPath = join(staging, "entry")
        await cp(path, copyPath, {
          recursive: true,
          dereference: true,
          filter: (source) => !(basename(dirname(source)) === "node_modules" && basename(source) === ".bin"),
        })
        await rm(path, { force: true, recursive: true })
        await rename(copyPath, path)
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
      entry = await lstat(path)
    }
    if (entry.isDirectory()) await materializeDirectory(path)
  }
}

async function unsupportedEntries(root: string, directory: string): Promise<string[]> {
  const unsupported: string[] = []
  for (const name of await readdir(directory)) {
    const path = join(directory, name)
    const entry = await lstat(path)
    if (entry.isDirectory()) unsupported.push(...await unsupportedEntries(root, path))
    else if (!entry.isFile()) unsupported.push(relative(root, path))
  }
  return unsupported
}
