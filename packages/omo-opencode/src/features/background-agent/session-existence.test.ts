import { describe, expect, mock, test } from "bun:test"

import type { OpencodeClient } from "./opencode-client"
import { checkSessionExistence, verifySessionExists } from "./session-existence"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"

describe("verifySessionExists", () => {
  test("passes query directory to session lookup when provided", async () => {
    // given
    const get = mock(async () => ({ data: { id: "session-123" } }))
    const client = unsafeTestValue<OpencodeClient>({
      session: {
        get,
      },
    })

    // when
    const result = await verifySessionExists(client, "session-123", "/project/root")

    // then
    expect(result).toBe(true)
    expect(get).toHaveBeenCalledWith({
      path: { id: "session-123" },
      query: { directory: "/project/root" },
    })
  })

  test("classifies transient lookup errors as unknown", async () => {
    const get = mock(async () => ({
      error: { message: "Network timeout", status: 500 },
      data: undefined,
    }))
    const client = unsafeTestValue<OpencodeClient>({
      session: {
        get,
      },
    })

    const result = await checkSessionExistence(client, "session-123")

    expect(result).toBe("unknown")
  })
})

describe("checkSessionExistence for the SDK not-found shape", () => {
  test("#given session.get answers with the SDK NotFoundError body #when checking #then the session is missing", async () => {
    // given
    const client = unsafeTestValue<OpencodeClient>({
      session: {
        get: mock(async () => ({
          data: undefined,
          error: { name: "NotFoundError", data: { message: "Session not found: session-123" } },
        })),
      },
    })

    // when
    const result = await checkSessionExistence(client, "session-123")

    // then
    expect(result).toBe("missing")
  })
})
