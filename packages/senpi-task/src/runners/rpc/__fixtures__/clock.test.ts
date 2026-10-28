import { afterEach, expect, test } from "bun:test"
import { fakeClock } from "./clock"

let clock: ReturnType<typeof fakeClock> | undefined
afterEach(() => clock?.restore())

// One bun process runs every test file, so work an earlier test left running can arm a timer while a later test's
// clock is installed. Counting it made that test's `pending()` assertion depend on host load (#11446).
test("#given work another test left running #when it arms a timer under this clock #then it keeps the real clock and is not counted", async () => {
  let resume!: () => void
  const leftover = new Promise<void>((resolve) => { resume = resolve })
    .then(() => new Promise<number>((resolve) => setTimeout(() => resolve(Date.now()), 1)))
  clock = fakeClock()
  setTimeout(() => {}, 1)
  resume()
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(clock.pending()).toBe(1)
  expect(await leftover).toBeGreaterThan(clock.now())
  await clock.advance(1)
  expect(clock.pending()).toBe(0)
})
