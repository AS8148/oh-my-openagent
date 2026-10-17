import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { openDoriReplay, resolveReplayTurn, splitReplayContext, type DoriReplay, type ReplayTurn } from "./dori-replay"

const DAY = 24 * 60 * 60 * 1000
const directories: string[] = []
const replays: DoriReplay[] = []
afterEach(() => {
  for (const replay of replays.splice(0)) replay.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function journalPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "dori-replay-"))
  directories.push(directory)
  return join(directory, "toolkit-replay.sqlite")
}

async function open(path: string, now: () => number = () => 1_000): Promise<DoriReplay> {
  const replay = await openDoriReplay({ path, now })
  replays.push(replay)
  return replay
}

function counted(value: unknown) {
  let calls = 0
  return { dispatch: async () => { calls += 1; return value }, calls: () => calls }
}

const turn = (callIndex: number, turnAt = 0, turnId = "dur-a:a1/cell-a"): ReplayTurn => ({ turnId, turnAt, callIndex })

test("#given a recorded turn #when a fresh process replays the same calls with the same arguments #then each returns its recorded result without a second dispatch", async () => {
  const path = journalPath()
  const first = await open(path)
  const mark = counted({ kind: "ok", value: { marked: true } })
  const post = counted({ kind: "ok", value: { posted: 1 } })
  expect(await first.run(turn(0), "reply.mark", { id: "d1" }, mark.dispatch)).toEqual({ kind: "ok", value: { marked: true } })
  expect(await first.run(turn(1), "send.post", { text: "hi", room: "r" }, post.dispatch)).toEqual({ kind: "ok", value: { posted: 1 } })
  first.close()
  const replay = await open(path)
  const markAgain = counted("second")
  const postAgain = counted("second")
  expect(await replay.run(turn(0), "reply.mark", { id: "d1" }, markAgain.dispatch)).toEqual({ kind: "ok", value: { marked: true } })
  expect(await replay.run(turn(1), "send.post", { room: "r", text: "hi" }, postAgain.dispatch)).toEqual({ kind: "ok", value: { posted: 1 } })
  expect([mark.calls(), post.calls(), markAgain.calls(), postAgain.calls()]).toEqual([1, 1, 0, 0])
})

test("#given a recorded op at an index #when a replay calls a different op there #then it stops with a divergence naming the op", async () => {
  const path = journalPath()
  await (await open(path)).run(turn(0), "reply.mark", { id: "d1" }, counted(1).dispatch)
  const post = counted(2)
  expect(await (await open(path)).run(turn(0), "send.post", { id: "d1" }, post.dispatch)).toMatchObject({
    kind: "replay_stopped",
    code: "toolkit_replay_divergence",
    key: '["turn","dur-a:a1/cell-a",0]',
    differs: ["op"],
    recorded_op: "reply.mark",
    attempted_op: "send.post",
  })
  expect(post.calls()).toBe(0)
})

test("#given a recorded call #when a replay makes the same op with different arguments #then it stops with a divergence naming the arguments", async () => {
  const path = journalPath()
  await (await open(path)).run(turn(0), "send.post", { text: "hello" }, counted({ kind: "ok", value: { text: "hello" } }).dispatch)
  const changed = counted("sent-2")
  expect(await (await open(path)).run(turn(0), "send.post", { text: "DIFFERENT" }, changed.dispatch)).toMatchObject({
    kind: "replay_stopped",
    code: "toolkit_replay_divergence",
    differs: ["args"],
    recorded_op: "send.post",
    attempted_op: "send.post",
  })
  expect(changed.calls()).toBe(0)
})

test("#given a dispatch that throws #when it fails #then the claim is released and a retry dispatches again", async () => {
  const path = journalPath()
  const failing = await open(path)
  await expect(failing.run(turn(0), "reply.mark", {}, async () => { throw new Error("transport down") })).rejects.toThrow("transport down")
  failing.close()
  const retry = counted({ kind: "ok", value: true })
  expect(await (await open(path)).run(turn(0), "reply.mark", {}, retry.dispatch)).toEqual({ kind: "ok", value: true })
  expect(retry.calls()).toBe(1)
})

test("#given a claim whose process died before recording #when a replay reaches it #then it stops as pending instead of re-sending", async () => {
  const path = journalPath()
  const crashed = await open(path)
  let release = (): void => undefined
  const inflight = crashed.run(turn(0), "reply.mark", {}, () => new Promise((resolve) => { release = () => resolve("late") }))
  const again = counted("again")
  expect(await (await open(path)).run(turn(0), "reply.mark", {}, again.dispatch)).toMatchObject({ kind: "replay_stopped", code: "toolkit_replay_pending", key: '["turn","dur-a:a1/cell-a",0]' })
  expect(again.calls()).toBe(0)
  release()
  expect(await inflight).toBe("late")
})

test("#given a turn older than the seven-day window #when its call is replayed #then it stops as expired without dispatching, whether or not its row survived", async () => {
  const path = journalPath()
  await (await open(path, () => 0)).run(turn(0), "reply.mark", {}, counted("old").dispatch)
  const kept = counted("kept")
  expect(await (await open(path, () => 7 * DAY - 1)).run(turn(0), "reply.mark", {}, kept.dispatch)).toBe("old")
  const late = counted("sent-2")
  expect(await (await open(path, () => 8 * DAY)).run(turn(0), "reply.mark", {}, late.dispatch)).toMatchObject({ kind: "replay_stopped", code: "toolkit_replay_expired", key: '["turn","dur-a:a1/cell-a",0]' })
  const unseen = counted("never")
  expect(await (await open(path, () => 8 * DAY)).run(turn(5), "send.post", {}, unseen.dispatch)).toMatchObject({ code: "toolkit_replay_expired" })
  expect([kept.calls(), late.calls(), unseen.calls()]).toEqual([0, 0, 0])
  const db = new Database(path)
  try {
    expect((db.query("SELECT count(*) AS n FROM toolkit_replay").get() as { n: number }).n).toBe(0)
  } finally {
    db.close()
  }
})

const at = (iso: string) => Date.parse(iso)
const branch = [
  { type: "message", id: "u1", timestamp: "2026-10-17T00:00:00.000Z", message: { role: "user" } },
  { type: "message", id: "a1", timestamp: "2026-10-17T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "x" }, { type: "toolCall", id: "cell-a", name: "eval" }] } },
  { type: "message", id: "t1", timestamp: "2026-10-17T00:00:02.000Z", message: { role: "toolResult", toolCallId: "cell-a" } },
  { type: "message", id: "a2", timestamp: "2026-10-17T00:00:03.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "cell-b", name: "eval" }] } },
]
const ectx = { sessionManager: { getBranch: () => branch } }

test("#given a cell that outlived its turn #when it calls after the session moved on #then the call keeps the turn the cell started in", () => {
  expect(resolveReplayTurn("dur-a", ectx, { cell: "cell-a", index: 2 }, "kernel-call")).toEqual({ turnId: "dur-a:a1/cell-a", turnAt: at("2026-10-17T00:00:01.000Z"), callIndex: 2 })
  expect(resolveReplayTurn("dur-a", ectx, { cell: "cell-b", index: 0 }, "kernel-call")).toEqual({ turnId: "dur-a:a2/cell-b", turnAt: at("2026-10-17T00:00:03.000Z"), callIndex: 0 })
})

test("#given a model tool call with no carried context #when the turn is resolved #then its own tool call is the cell at index 0", () => {
  expect(resolveReplayTurn("dur-a", ectx, undefined, "cell-b")).toEqual({ turnId: "dur-a:a2/cell-b", turnAt: at("2026-10-17T00:00:03.000Z"), callIndex: 0 })
})

test("#given a carried turn the engine did not issue #when it is resolved #then the call is refused as an unknown turn", () => {
  for (const carried of [{ cell: "cell-of-another-session", index: 0 }, { cell: "cell-a", index: -1 }, { cell: "cell-a", index: 1.5 }, { cell: 7, index: 0 }, "cell-a"]) {
    expect(resolveReplayTurn("dur-a", ectx, carried, "kernel-call")).toMatchObject({ kind: "replay_stopped", code: "toolkit_replay_turn_unknown" })
  }
  expect(resolveReplayTurn("dur-a", { sessionManager: {} }, undefined, "cell-b")).toMatchObject({ code: "toolkit_replay_turn_unknown" })
})

test("#given key-shaped arguments #when the context is split and journaled #then they stay op arguments and the journal key is the engine's own", async () => {
  const forged = { note: "n", replay_key: '["turn","evil",0]', turn_id: "evil", turnId: "evil", callIndex: 9, omo_toolkit_replay: { cell: "cell-a", index: 1 } }
  const split = splitReplayContext(forged)
  expect(split).toEqual({ carried: { cell: "cell-a", index: 1 }, args: { note: "n", replay_key: '["turn","evil",0]', turn_id: "evil", turnId: "evil", callIndex: 9 } })
  const resolved = resolveReplayTurn("dur-a", ectx, split.carried, "kernel-call")
  if ("kind" in resolved) throw new Error(resolved.message)
  const path = journalPath()
  await (await open(path)).run(resolved, "reply.mark", split.args, counted("ok").dispatch)
  const db = new Database(path)
  try {
    expect(db.query("SELECT replay_key FROM toolkit_replay").all()).toEqual([{ replay_key: '["turn","dur-a:a1/cell-a",1]' }])
  } finally {
    db.close()
  }
})
