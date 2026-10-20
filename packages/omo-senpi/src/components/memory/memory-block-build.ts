import { statSync } from "node:fs"
import { fileURLToPath } from "node:url"

declare const OMO_SENPI_PACKAGE_VERSION: string

/**
 * Identifies the code that compiles memory blocks, for the persisted-block key: the package version plus the size and
 * mtime of the running bundle, so a rebuild under an unchanged version (a dev or desktop-pinned build) still never
 * reads a block another build compiled.
 */
export function memoryBlockBuild(): string {
  const version = typeof OMO_SENPI_PACKAGE_VERSION === "string" ? OMO_SENPI_PACKAGE_VERSION : "dev"
  try {
    const bundle = statSync(fileURLToPath(import.meta.url))
    return `${version}:${bundle.size}:${Math.trunc(bundle.mtimeMs)}`
  } catch {
    return `${version}:unknown`
  }
}
