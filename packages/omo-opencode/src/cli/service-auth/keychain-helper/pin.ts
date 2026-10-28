import { rmSync } from "node:fs"
import { chmod, copyFile, constants, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import type { SignatureVerdict } from "./signature"

let processDir: Promise<string> | undefined

// One private directory per process (mode 0700 by mkdtemp), removed when the process exits.
function processPinDir(): Promise<string> {
  processDir ??= mkdtemp(join(tmpdir(), "omo-keychain-")).then(dir => {
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }))
    return dir
  })
  return processDir
}

/**
 * Copies a located helper into a directory only this process uses, makes the copy read-only, and verifies the COPY.
 * The process then spawns only that copy, so a file written to the original path later (a dev build, a broken
 * install) is never executed. The signature is inside the Mach-O, so the copy has the same designated requirement and
 * the same keychain access as the original (#11262 design 1: every copy at any path matches one ACL entry).
 * Returns null when the copy fails its check.
 */
export async function pinVerifiedCopy(
  source: string,
  verify: (path: string) => Promise<SignatureVerdict>,
  dir?: string,
): Promise<string | null> {
  const target = join(dir ?? (await processPinDir()), `${crypto.randomUUID()}-${basename(source)}`)
  await copyFile(source, target, constants.COPYFILE_EXCL)
  await chmod(target, 0o500)
  if ((await verify(target)) === "valid") return target
  await rm(target, { force: true })
  return null
}
