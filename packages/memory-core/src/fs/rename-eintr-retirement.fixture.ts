import { mock } from "bun:test"
import * as filesystem from "node:fs/promises"

const entered = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
const controller = new AbortController()
let syscalls = 0
mock.module("node:fs/promises", () => ({
  ...filesystem,
  rename: async () => {
    syscalls++
    if (syscalls === 1) {
      entered.resolve()
      await release.promise
      throw Object.assign(new Error("synthetic interrupt"), { code: "EINTR" })
    }
  },
}))

// Load the real composition after installing the raw-syscall seam in this isolated process.
const { rename } = await import("./resilient")
const pending = rename("candidate", "pin", { signal: controller.signal }).then(
  () => ({ published: true, aborted: false }),
  (error: unknown) => {
    if (!(error instanceof Error) || error.name !== "AbortError") throw error
    return { published: false, aborted: true }
  },
)
await entered.promise
controller.abort()
release.resolve()
process.stdout.write(JSON.stringify({ ...(await pending), syscalls }))
