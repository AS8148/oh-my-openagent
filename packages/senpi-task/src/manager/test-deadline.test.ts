import { afterAll, expect, spyOn, test } from "bun:test"
import { DEFAULT_TEST_TIMEOUT_MS, remainingTestTime } from "../../../../test-support/test-deadline"

const now = performance.now()
const clock = spyOn(performance, "now").mockReturnValue(now)
afterAll(() => { clock.mockRestore() })

test("#given an earlier test #when its clock exhausts the launch budget #then no time remains", () => {
  clock.mockReturnValue(now + DEFAULT_TEST_TIMEOUT_MS * 2)
  expect(remainingTestTime()).toBe(0)
})

test("#given the next test #when its preload resets the stopwatch #then it has its own launch budget", () => {
  expect(remainingTestTime()).toBeGreaterThan(DEFAULT_TEST_TIMEOUT_MS * 0.89)
  expect(remainingTestTime()).toBeLessThanOrEqual(DEFAULT_TEST_TIMEOUT_MS * 0.9)
  expect(remainingTestTime(15_000)).toBeGreaterThan(15_000 * 0.89)
  expect(remainingTestTime(15_000)).toBeLessThanOrEqual(13_500)
})
