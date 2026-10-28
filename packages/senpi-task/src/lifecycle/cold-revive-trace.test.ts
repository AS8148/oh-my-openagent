import { once } from "node:events"

import { describe, expect, test } from "bun:test"

import { createColdReviveTrace } from "./__fixtures__/cold-revive-trace"

const WINDOW_MS = 200
const GAP_MS = 100

describe("cold-revive progress watchdog", () => {
  // Guards the residency test's "never stricter than the product" contract (#10993): the product arms a
  // request's deadline when it writes the request, so the watchdog must not fire before that deadline.
  test("#given a request written after the last stage #when the child stays silent #then the stall is counted from the write", async () => {
    // given a traced child that never answers, and a watchdog armed at its last stage
    const trace = createColdReviveTrace()
    const child = trace.spawnProcess(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "pipe", "pipe"] })
    await once(child, "spawn")
    const progress = trace.watchProgress(WINDOW_MS)
    try {
      // when a request goes out some time after that stage
      await new Promise((resolve) => setTimeout(resolve, GAP_MS))
      const sentAt = performance.now()
      child.stdin?.write(`${JSON.stringify({ type: "get_state", id: "probe" })}\n`)
      const error = await progress.stalled.catch((stall: unknown) => stall)
      const firedAfterSendMs = performance.now() - sentAt

      // then the stall fires a full window after the write and names it
      expect(firedAfterSendMs).toBeGreaterThanOrEqual(WINDOW_MS)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain("\"request_sent:get_state (launch 1)\"")
    } finally {
      progress.dispose()
      const closed = once(child, "close")
      child.kill()
      await closed
    }
  })
})
