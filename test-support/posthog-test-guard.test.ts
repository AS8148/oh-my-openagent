import { describe, expect, test } from "bun:test"

import { createPostHogTestGuard } from "./posthog-test-guard"

function fakeClientClass() {
  const sent: string[] = []
  class FakeClient {
    disabled = false
    timerCleared = false
    fetch(url: string, _options: unknown): Promise<unknown> {
      sent.push(url)
      return Promise.resolve({ status: 200 })
    }
    capture(..._args: unknown[]): unknown {
      return undefined
    }
    shutdown(..._args: unknown[]): Promise<unknown> {
      return Promise.resolve()
    }
    clearFlushTimer(): void {
      this.timerCleared = true
    }
  }
  return { FakeClient, sent, guard: createPostHogTestGuard(FakeClient.prototype) }
}

describe("PostHog test guard (#10394)", () => {
  test("#given a client that captures and shuts down within its test #when the test ends #then nothing is reported and loopback sends pass through", async () => {
    // given
    const { FakeClient, sent, guard } = fakeClientClass()
    guard.beginTest()
    const client = new FakeClient()

    // when
    client.capture({ event: "e" })
    await client.fetch("http://127.0.0.1:4318/batch/", {})
    await client.shutdown()

    // then
    expect(guard.endTest()).toEqual([])
    expect(sent).toEqual(["http://127.0.0.1:4318/batch/"])
  })

  test("#given a client left running #when its test ends #then it is reported and its later flush never reaches fetch", async () => {
    // given
    const { FakeClient, sent, guard } = fakeClientClass()
    guard.beginTest()
    const client = new FakeClient()
    client.capture({ event: "e" })

    // when
    const violations = guard.endTest()
    guard.beginTest()
    const lateFlush = client.fetch("http://127.0.0.1:4318/batch/", {})

    // then
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain("never shut down")
    expect(client.disabled).toBe(true)
    expect(client.timerCleared).toBe(true)
    await expect(lateFlush).rejects.toThrow("outlived its test")
    expect(sent).toEqual([])
    expect(guard.endTest()).toHaveLength(1)
  })

  test("#given a client pointed at a real analytics host #when it sends #then the request is refused and reported", async () => {
    // given
    const { FakeClient, sent, guard } = fakeClientClass()
    guard.beginTest()
    const client = new FakeClient()

    // when
    const send = client.fetch("https://us.i.posthog.com/batch/", {})

    // then
    await expect(send).rejects.toThrow("never send product telemetry")
    await client.shutdown()
    const violations = guard.endTest()
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain("https://us.i.posthog.com/batch/")
    expect(sent).toEqual([])
  })
})
