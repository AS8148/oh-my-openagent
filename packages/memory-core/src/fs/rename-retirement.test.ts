import { expect, test } from "bun:test"

import { renameWithContentionRetry } from "./rename-contention"

// #11737: a retry is a new publication attempt, not completion of the first syscall.
test.each(["EPERM", "EBUSY"])("retirement during %s backoff prevents the next rename dispatch", async (code) => {
  // Given: the first Windows syscall fails and the retry has not yet been admitted.
  const controller = new AbortController()
  const sleeping = Promise.withResolvers<void>()
  const retry = Promise.withResolvers<void>()
  let syscalls = 0
  const deps = {
    platform: "win32" as const,
    signal: controller.signal,
    delaysMs: [1],
    rename: async () => {
      syscalls++
      if (syscalls === 1) throw Object.assign(new Error("synthetic contention"), { code })
    },
    sleep: async () => {
      sleeping.resolve()
      await retry.promise
    },
  }
  const outcome = renameWithContentionRetry("candidate", "pin", deps).then(
    () => ({ kind: "published" as const }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  )
  await sleeping.promise

  // When: authority retires before the next raw rename is dispatched.
  controller.abort()
  retry.resolve()
  const settled = await outcome

  // Then: no second syscall runs and cancellation is not swallowed as contention.
  expect(syscalls).toBe(1)
  expect(settled.kind).toBe("rejected")
  if (settled.kind === "rejected") expect(settled.error).toMatchObject({ name: "AbortError" })
})
