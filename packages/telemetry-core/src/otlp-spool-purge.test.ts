import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { createBatchId } from "./otlp-spool-dir"
import { purgeSpool } from "./otlp-spool-purge"
import { createSpoolRoot, spoolNames } from "./otlp-test-support"
import type { TelemetrySpoolEntryKind } from "./types"

const roots: (() => void)[] = []
afterEach(() => {
  for (const cleanup of roots.splice(0)) cleanup()
})

function spool(): { dir: string; sealed: string; wal: string } {
  const created = createSpoolRoot("telemetry-core-spool-purge-")
  roots.push(created.cleanup)
  mkdirSync(created.dir, { recursive: true })
  const sealed = `batch-logs-${createBatchId(Date.now())}.otlp`
  const wal = `active-logs-999-${"b".repeat(32)}.otlp`
  writeFileSync(join(created.dir, sealed), "sealed")
  writeFileSync(join(created.dir, wal), "wal")
  return { dir: created.dir, sealed, wal }
}

function errnoError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

describe("the purge never follows, opens or deletes a spool-named entry that is not a regular file", () => {
  test.skipIf(process.platform === "win32")(
    "#given a spool-named FIFO next to a real spool file #when the purge runs #then the FIFO survives without blocking the purge, it is reported as other, and the real spool file is deleted",
    () => {
      // given
      const { dir, sealed, wal } = spool()
      const fifo = `batch-traces-${createBatchId(Date.now() - 1)}.otlp`
      execFileSync("mkfifo", [join(dir, fifo)])
      const kinds: TelemetrySpoolEntryKind[] = []

      // when
      const outcome = purgeSpool(dir, dirname(dir), (kind) => kinds.push(kind))

      // then
      expect(outcome).toBe("purged")
      expect(kinds).toEqual(["other"])
      expect(spoolNames(dir)).toEqual([fifo])
      expect(spoolNames(dir)).not.toContain(sealed)
      expect(spoolNames(dir)).not.toContain(wal)
    },
    5_000,
  )

  test("#given a spool-named symlink to a file outside the spool #when the purge runs #then neither the link nor its target is touched, the skip is reported as symlink, and the real spool files are deleted", () => {
    // given
    const { dir } = spool()
    const target = join(dirname(dir), "link-target.txt")
    writeFileSync(target, "keep")
    const link = `active-traces-1-${"c".repeat(32)}.otlp`
    symlinkSync(target, join(dir, link), "file")
    const kinds: TelemetrySpoolEntryKind[] = []

    // when
    const outcome = purgeSpool(dir, dirname(dir), (kind) => kinds.push(kind))

    // then
    expect(outcome).toBe("purged")
    expect(kinds).toEqual(["symlink"])
    expect(spoolNames(dir)).toEqual([link])
    expect(readFileSync(target, "utf8")).toBe("keep")
  })
})

describe("the purge keeps sweeping when one entry cannot be deleted", () => {
  for (const code of ["EISDIR", "EPERM", "ENOTDIR"]) {
    test(`#given a spool-named entry swapped after its check so its unlink fails with ${code} #when the purge runs #then that entry is skipped and reported as other and every other spool file is still deleted`, () => {
      // given
      const { dir, sealed, wal } = spool()
      const kinds: TelemetrySpoolEntryKind[] = []
      const swapped = join(dir, sealed)
      const unlink = (path: string): void => {
        if (path === swapped) throw errnoError(code)
        unlinkSync(path)
      }

      // when
      const outcome = purgeSpool(dir, dirname(dir), (kind) => kinds.push(kind), { unlink })

      // then
      expect(outcome).toBe("purged")
      expect(kinds).toEqual(["other"])
      expect(spoolNames(dir)).toEqual([sealed])
      expect(spoolNames(dir)).not.toContain(wal)
    })
  }

  test("#given an unlink failure that is not a swapped entry #when the purge runs #then the error still propagates", () => {
    // given
    const { dir } = spool()
    const unlink = (): void => {
      throw errnoError("EIO")
    }

    // when
    const run = (): unknown => purgeSpool(dir, dirname(dir), () => undefined, { unlink })

    // then
    expect(run).toThrow("EIO")
  })
})

describe("the purge leaves a spool file of another user in an owned spool directory", () => {
  test.skipIf(typeof process.getuid !== "function")(
    "#given the spool directory is owned by the current user and one spool file by another #when the purge runs #then that file survives, is reported as foreign_owner, and the rest is deleted",
    () => {
      // given
      const { dir, sealed, wal } = spool()
      const foreign = join(dir, wal)
      const ownerOf = (path: string, uid: number): number => (path === foreign ? uid + 1 : uid)
      const kinds: TelemetrySpoolEntryKind[] = []

      // when
      const outcome = purgeSpool(dir, dirname(dir), (kind) => kinds.push(kind), { ownerOf })

      // then
      expect(outcome).toBe("purged")
      expect(kinds).toEqual(["foreign_owner"])
      expect(spoolNames(dir)).toEqual([wal])
      expect(spoolNames(dir)).not.toContain(sealed)
    },
  )
})
