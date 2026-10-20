import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import type { PluginInput } from "@opencode-ai/plugin"
import type { ToolContext } from "@opencode-ai/plugin/tool"

// Contract (#10738): session_read / session_search / session_info page through OpenCode's message API
// with a limit on every request, never hold a whole session, and a timed-out search stops reading.

const TEST_DIR = join(tmpdir(), `omo-test-session-paging-${randomUUID()}`)

mock.module("./constants", () => ({
  OPENCODE_STORAGE: TEST_DIR,
  MESSAGE_STORAGE: join(TEST_DIR, "message"),
  PART_STORAGE: join(TEST_DIR, "part"),
  SESSION_STORAGE: join(TEST_DIR, "session"),
  TODO_DIR: join(TEST_DIR, "todos"),
  TRANSCRIPT_DIR: join(TEST_DIR, "transcripts"),
  SESSION_LIST_DESCRIPTION: "test",
  SESSION_READ_DESCRIPTION: "test",
  SESSION_SEARCH_DESCRIPTION: "test",
  SESSION_INFO_DESCRIPTION: "test",
  SESSION_DELETE_DESCRIPTION: "test",
  TOOL_NAME_PREFIX: "session_",
}))

mock.module("../../shared/opencode-storage-detection", () => ({
  isSqliteBackend: () => true,
  resetSqliteBackendCache: () => {},
}))

mock.module("../../shared/opencode-message-dir", () => ({
  getMessageDir: () => null,
}))

afterAll(() => {
  mock.restore()
})

const { createSessionManagerTools } = await import("./tools")
const { resetStorageClient } = await import("./storage")

type Request = { sessionID: string; limit?: number; before?: string; signal?: AbortSignal }

// Serves GET /session/:id/message the way OpenCode's MessageV2.page does: `limit` returns the newest
// `limit` messages in ascending order plus an X-Next-Cursor header when older ones remain; no limit
// returns everything.
function createFakeServer(sessions: Record<string, number>) {
  const requests: Request[] = []
  let fetchedMessages = 0
  let largestResponse = 0
  let gate: { onRequest: (request: Request) => Promise<void> } | undefined

  const message = (sessionID: string, index: number) => ({
    info: { id: `msg_${String(index).padStart(6, "0")}`, role: index % 2 === 0 ? "user" : "assistant", time: { created: 1_000 + index } },
    parts: [{ id: `prt_${index}`, type: "text", text: `${sessionID} message ${index}${index === 0 ? " needle-oldest" : ""}` }],
  })

  const client = {
    session: {
      messages: async (input: { path: { id: string }; query?: { limit?: number; before?: string }; signal?: AbortSignal }) => {
        const request: Request = { sessionID: input.path.id, limit: input.query?.limit, before: input.query?.before, signal: input.signal }
        requests.push(request)
        if (gate) await gate.onRequest(request)
        input.signal?.throwIfAborted()
        const total = sessions[input.path.id] ?? 0
        const end = request.before === undefined ? total : Number(request.before)
        const start = request.limit ? Math.max(0, end - request.limit) : 0
        const data = Array.from({ length: end - start }, (_, offset) => message(input.path.id, start + offset))
        fetchedMessages += data.length
        largestResponse = Math.max(largestResponse, data.length)
        const headers = new Headers(request.limit && start > 0 ? { "X-Next-Cursor": String(start) } : {})
        return { data, response: new Response(null, { headers }) }
      },
      todo: async () => ({ data: [] }),
      list: async () => ({ data: [] }),
    },
  }

  return {
    client,
    requests,
    get fetchedMessages() {
      return fetchedMessages
    },
    get largestResponse() {
      return largestResponse
    },
    setGate(next: typeof gate) {
      gate = next
    },
  }
}

function createContext(): ToolContext {
  return {
    sessionID: "ses_caller",
    messageID: "msg_caller",
    agent: "test-agent",
    directory: TEST_DIR,
    worktree: TEST_DIR,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

function createTools(server: ReturnType<typeof createFakeServer>, sessionIDs: string[] = []) {
  return createSessionManagerTools({ directory: TEST_DIR, client: server.client } as unknown as PluginInput, {
    getAllSessions: async () => sessionIDs,
  })
}

const SESSION_SIZE = 1_000

describe("session-manager paging (#10738)", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(() => {
    jest.useRealTimers()
    resetStorageClient()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test("#given a long session #when session_read asks for the last 2 messages #then only those 2 are fetched, every request carrying a limit", async () => {
    //#given
    const server = createFakeServer({ ses_big: SESSION_SIZE })
    const { session_read } = createTools(server)

    //#when
    const output = await session_read.execute({ session_id: "ses_big", limit: 2, from_end: true }, createContext())

    //#then
    expect(output).toContain("ses_big message 998")
    expect(output).toContain("ses_big message 999")
    expect(output).not.toContain("ses_big message 997")
    expect(server.requests.every((request) => request.limit !== undefined)).toBe(true)
    expect(server.fetchedMessages).toBeLessThanOrEqual(3)
  })

  test("#given a long session #when session_read asks for the first 2 messages #then it pages from the newest end and no response holds more than one page", async () => {
    //#given
    const server = createFakeServer({ ses_big: SESSION_SIZE })
    const { session_read } = createTools(server)

    //#when
    const output = await session_read.execute({ session_id: "ses_big", limit: 2 }, createContext())

    //#then
    expect(output).toContain("ses_big message 0 needle-oldest")
    expect(output).toContain("ses_big message 1")
    expect(output).not.toContain("ses_big message 2")
    expect(server.requests.every((request) => request.limit !== undefined)).toBe(true)
    expect(server.largestResponse).toBeLessThan(SESSION_SIZE)
  })

  test("#given a long session #when session_info counts it #then the count is exact while every request carries a limit", async () => {
    //#given
    const server = createFakeServer({ ses_big: SESSION_SIZE })
    const { session_info } = createTools(server)

    //#when
    const output = await session_info.execute({ session_id: "ses_big" }, createContext())

    //#then
    expect(output).toContain(`Messages: ${SESSION_SIZE}`)
    expect(server.requests.every((request) => request.limit !== undefined)).toBe(true)
    expect(server.largestResponse).toBeLessThan(SESSION_SIZE)
  })

  test("#given a match in the newest messages #when session_search is limited to 1 result #then it stops after the first page", async () => {
    //#given
    const server = createFakeServer({ ses_big: SESSION_SIZE })
    const { session_search } = createTools(server)

    //#when
    const output = await session_search.execute({ query: "ses_big message 99", session_id: "ses_big", limit: 1 }, createContext())

    //#then
    expect(output).toContain("Found 1 matches")
    expect(server.requests.every((request) => request.limit !== undefined)).toBe(true)
    expect(server.fetchedMessages).toBeLessThan(SESSION_SIZE)
  })

  test("#given a search blocked on a slow read #when its timeout fires #then the in-flight read is aborted and no further reads are made", async () => {
    //#given
    jest.useFakeTimers()
    const server = createFakeServer({ ses_a: SESSION_SIZE, ses_b: SESSION_SIZE, ses_c: SESSION_SIZE })
    let releaseRead!: () => void
    const readBlocked = new Promise<Request>((resolveBlocked) => {
      server.setGate({
        onRequest: (request) =>
          new Promise<void>((resolveRead) => {
            releaseRead = resolveRead
            resolveBlocked(request)
          }),
      })
    })
    const { session_search } = createTools(server, ["ses_a", "ses_b", "ses_c"])
    const output = session_search.execute({ query: "zz-no-match" }, createContext())
    const blocked = await Promise.race([
      readBlocked,
      output.then(() => {
        throw new Error("search settled before its first read was observed")
      }),
    ])
    server.setGate(undefined)

    //#when
    jest.advanceTimersByTime(60_000)
    const result = await output

    //#then
    expect(result).toContain("timed out")
    expect(blocked.signal?.aborted).toBe(true)
    const requestsAtTimeout = server.requests.length
    releaseRead()
    jest.useRealTimers()
    await new Promise<void>((drained) => setImmediate(drained))
    expect(server.requests.length).toBe(requestsAtTimeout)
  })
})
