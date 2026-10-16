import { afterEach, describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { findOpenFileHolderPids } from "./open-file-holders"

// omo #10199 r5 HIGH 2 (macOS source contract): a slow but correct lsof answer is an answer.
// Latency is the behavior under test, so the stand-in lsof deliberately answers "no holders"
// (exit 1, empty stdout) only after 6 s - longer than the 5 s wall-clock deadline that used to
// race it and turn a CPU-starved host's answer into "indeterminate".

const roots: string[] = []
const realPath = process.env.PATH
afterEach(async () => {
  process.env.PATH = realPath
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("macOS open-file holder lookup", () => {
  test.skipIf(process.platform === "win32" || process.platform === "linux")("#given lsof answers 'no holders' slower than five seconds #then the lookup reports no holders instead of indeterminate", async () => {
    // #given
    const root = realpathSync.native(await mkdtemp(join(tmpdir(), "memory-slow-lsof-")))
    roots.push(root)
    await mkdir(join(root, "bin"))
    const fakeLsof = join(root, "bin", "lsof")
    await writeFile(fakeLsof, "#!/bin/sh\nsleep 6\nexit 1\n", "utf8")
    await chmod(fakeLsof, 0o755)
    const lock = join(root, "index.lock")
    await writeFile(lock, "", "utf8")
    process.env.PATH = `${join(root, "bin")}:${realPath ?? ""}`

    // #when
    const holders = await findOpenFileHolderPids(lock)

    // #then
    expect(holders).toEqual([])
  }, 30_000)
})
