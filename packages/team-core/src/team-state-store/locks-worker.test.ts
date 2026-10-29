import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Worker } from "node:worker_threads"
import { z } from "zod"

import { getProcessStartIdentity } from "../../../memory-core/src/locks/process-identity"
import { removeLockRecordIfUnchanged } from "./lock-reclaim"
import { buildLockRecord, markLockRecordHeld, markLockRecordReleased } from "./lock-record"
import { detectStaleLock, reapStaleLock, withLock } from "./locks"

const Reply = z.object({
  event: z.string(),
  record: z.string().optional(),
  stale: z.boolean().optional(),
  reaped: z.string().optional(),
  published: z.boolean().optional(),
})

function reply(worker: Worker, event: string): Promise<z.infer<typeof Reply>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`worker never sent ${event}`)), 10_000)
    const onError = (error: Error) => done(error)
    const onExit = (code: number) => done(new Error(`worker exited ${code} before ${event}`))
    const onMessage = (message: unknown) => {
      const parsed = Reply.safeParse(message)
      if (parsed.success && parsed.data.event === event) done(undefined, parsed.data)
    }
    function done(error?: Error, value?: z.infer<typeof Reply>): void {
      clearTimeout(timer)
      worker.off("message", onMessage)
      worker.off("error", onError)
      worker.off("exit", onExit)
      if (error !== undefined) reject(error)
      else if (value !== undefined) resolve(value)
    }
    worker.on("message", onMessage)
    worker.once("error", onError)
    worker.once("exit", onExit)
  })
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "team-worker-lock-"))
  const lockPath = join(root, "owner.lock")
  const counters = new SharedArrayBuffer(12)
  const workers: Worker[] = []
  return {
    lockPath,
    state: new Int32Array(counters),
    async worker() {
      const worker = new Worker(new URL("./lock-worker.fixture.ts", import.meta.url), {
        workerData: { lockPath, counters },
      })
      workers.push(worker)
      await reply(worker, "ready")
      return worker
    },
    async close() {
      await Promise.all(workers.map((worker) => worker.terminate()))
      await rm(root, { recursive: true, force: true })
    },
  }
}

test("a sibling worker cannot reap or enter a live worker's lock", async () => {
  // given
  const f = await fixture()
  try {
    const a = await f.worker()
    const held = reply(a, "held")
    a.postMessage("hold")
    const original = (await held).record
    const b = await f.worker()
    const attempted = reply(b, "attempted")
    const entered = reply(b, "entered")
    // when
    b.postMessage("contend")
    const observation = await attempted
    const retained = await readFile(f.lockPath, "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
      throw error
    })
    const released = reply(a, "released")
    a.postMessage("release")
    await Promise.all([released, entered])
    const bReleased = reply(b, "released")
    b.postMessage("release")
    await bReleased
    // then
    expect(observation).toMatchObject({ stale: false, reaped: "changed", published: false })
    expect(retained).toBe(original)
    expect(Atomics.load(f.state, 1)).toBe(0)
    expect(Atomics.load(f.state, 2)).toBe(1)
  } finally {
    await f.close()
  }
}, 30_000)

test("host-observed worker exit allows a sibling to reclaim its lock", async () => {
  const f = await fixture()
  try {
    const a = await f.worker()
    const held = reply(a, "held")
    a.postMessage("hold")
    await held
    const b = await f.worker()
    await a.terminate()
    Atomics.store(f.state, 0, 0)
    const attempted = reply(b, "attempted")
    const entered = reply(b, "entered")
    b.postMessage("contend")
    expect(await attempted).toMatchObject({ stale: true, reaped: "removed" })
    await entered
    const released = reply(b, "released")
    b.postMessage("release")
    await released
    expect(Atomics.load(f.state, 2)).toBe(1)
  } finally {
    await f.close()
  }
}, 30_000)

test("a legacy module UUID mismatch is not evidence of PID reuse", async () => {
  const f = await fixture()
  try {
    await writeFile(f.lockPath, `legacy\n${process.pid}\n1\nother-module\n`)
    expect(await detectStaleLock(f.lockPath, Infinity)).toBe(false)
    expect(await reapStaleLock(f.lockPath, Infinity)).toBe("changed")
  } finally {
    await f.close()
  }
})

test("a delayed old release cannot delete a replacement record", async () => {
  const f = await fixture()
  try {
    const old = await buildLockRecord("old")
    markLockRecordHeld(old)
    await writeFile(f.lockPath, old)
    await unlink(f.lockPath)
    await withLock(f.lockPath, async () => {
      const replacement = await readFile(f.lockPath, "utf8")
      markLockRecordReleased(old)
      expect(await removeLockRecordIfUnchanged(f.lockPath, old, Infinity)).toBe("changed")
      expect(await readFile(f.lockPath, "utf8")).toBe(replacement)
    })
  } finally {
    await f.close()
  }
})

test("real process-start identity mismatch proves PID reuse", async () => {
  const f = await fixture()
  try {
    const start = await getProcessStartIdentity(process.pid)
    if (start === null) throw new Error("test requires the OS process-start identity")
    const priorStart = `${start.slice(0, start.indexOf(":"))}:0`
    await writeFile(f.lockPath, `prior\n${process.pid}\n1\nold-worker\n${priorStart}\n`)
    expect(await detectStaleLock(f.lockPath, Infinity)).toBe(true)
    expect(await withLock(f.lockPath, async () => "acquired", { staleAfterMs: Infinity })).toBe("acquired")
  } finally {
    await f.close()
  }
})

test("unknown worker and incomparable process identity retain ownership", async () => {
  const f = await fixture()
  try {
    await writeFile(f.lockPath, `unknown\n${process.pid}\n1\nunknown-worker\nunknown-scheme:0\n`)
    expect(await detectStaleLock(f.lockPath, Infinity)).toBe(false)
    expect(await reapStaleLock(f.lockPath, Infinity)).toBe("changed")
  } finally {
    await f.close()
  }
})
