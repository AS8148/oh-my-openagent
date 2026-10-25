import { describe, expect, test } from "bun:test"
import { mirrorChannel } from "./mirror-channel"

describe("mirrorChannel", () => {
  test("a dry run writes and reads the scratch pointer without changing the live channel", async () => {
    // given
    const scratch = new Map<string, string>()
    const liveWrites: string[] = []
    const store = {
      async readText(key: string) { return scratch.get(key) ?? null },
      async write(key: string, body: string) { scratch.set(key, body) },
    }
    const live = {
      async readText() { return "5.1.47\n" },
      async write(key: string) { liveWrites.push(key) },
    }
    // when
    const pointer = await mirrorChannel(store, live, "channels/latest", "5.1.48", true, false, () => {})
    // then
    expect(scratch.get("channels/latest")).toBe("5.1.48\n")
    expect(pointer).toBe("5.1.48")
    expect(liveWrites).toEqual([])
  })

  test("a production backfill preserves a newer live channel", async () => {
    // given
    const writes: string[] = []
    const store = {
      async readText() { return "5.1.49\n" },
      async write(key: string) { writes.push(key) },
    }
    // when
    const pointer = await mirrorChannel(store, store, "channels/latest", "5.1.48", false, false, () => {})
    // then
    expect(pointer).toBe("5.1.49")
    expect(writes).toEqual([])
  })

  test.each([false, true])("production force=%s writes and verifies the live pointer", async (force) => {
    // given
    let pointer = force ? "5.1.49\n" : "5.1.47\n"
    const store = {
      async readText() { return pointer },
      async write(_key: string, body: string) { pointer = body },
    }
    // when
    const result = await mirrorChannel(store, store, "channels/latest", "5.1.48", false, force, () => {})
    // then
    expect(result).toBe("5.1.48")
    expect(pointer).toBe("5.1.48\n")
  })

  test("a mismatched scratch read-back fails the dry run", async () => {
    // given
    const store = {
      async readText() { return null },
      async write() {},
    }
    // when
    const result = mirrorChannel(store, store, "channels/latest", "5.1.48", true, false, () => {})
    // then
    await expect(result).rejects.toThrow("pointer read-back")
  })
})
