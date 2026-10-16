import { afterEach, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { FSWatcher } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildIdentityPaths, type DeviceSync, type EngineStatus, type SyncSession } from "@oh-my-opencode/memory-core"

import { createSyncRunner, watchHeadLog } from "./sync-runner"

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function identity() {
  const root = await mkdtemp(join(tmpdir(), "omo-sync-runner-"))
  dirs.push(root)
  const paths = buildIdentityPaths(root, "agent")
  await mkdir(join(paths.repo, ".git", "logs"), { recursive: true })
  await writeFile(join(paths.repo, ".git", "logs", "HEAD"), "")
  return paths
}

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined }
const session = {} as SyncSession

function fakeOpen() {
  const opened: string[] = []
  const closed: string[] = []
  const started: string[] = []
  let commits = 0
  const open = async (o: { repoDir: string }): Promise<DeviceSync> => {
    opened.push(o.repoDir)
    return {
      engine: { start: () => started.push(o.repoDir) } as unknown as DeviceSync["engine"],
      status: async (): Promise<EngineStatus> => ({ kind: "never_synced" }),
      notifyLocalCommit: () => {
        commits += 1
      },
      close: async () => {
        closed.push(o.repoDir)
      },
    }
  }
  return { open, opened, closed, started, commits: () => commits }
}

test("sessions sharing a repository share one engine, started once and closed with the last session", async () => {
  const paths = await identity()
  const fake = fakeOpen()
  const runner = createSyncRunner({ logger, resolveSession: async () => session, open: fake.open, watchHead: () => () => undefined })
  await runner.acquire("agent", paths, { enabled: true })
  await runner.acquire("agent", paths, { enabled: true })
  expect([fake.opened, fake.started]).toEqual([[paths.repo], [paths.repo]])
  await runner.release(paths.repo)
  expect(fake.closed).toEqual([])
  expect(await runner.status(paths.repo)).toEqual({ kind: "never_synced" })
  await runner.release(paths.repo)
  expect(fake.closed).toEqual([paths.repo])
  expect(await runner.status(paths.repo)).toBeNull()
})

test("memory.sync.enabled false, or no signed-in device session, opens nothing", async () => {
  const paths = await identity()
  const fake = fakeOpen()
  const off = createSyncRunner({ logger, resolveSession: async () => session, open: fake.open, watchHead: () => () => undefined })
  await off.acquire("agent", paths, { enabled: false })
  const signedOut = createSyncRunner({ logger, resolveSession: async () => null, open: fake.open, watchHead: () => () => undefined })
  await signedOut.acquire("agent", paths, { enabled: true })
  expect(fake.opened).toEqual([])
  expect(await signedOut.status(paths.repo)).toBeNull()
  await signedOut.release(paths.repo)
})

test("a commit seen by the HEAD reflog watch starts a local-commit cycle, and one cycle follows arming", async () => {
  const paths = await identity()
  const fake = fakeOpen()
  let onChange: () => void = () => undefined
  let watched = ""
  let closed = false
  const runner = createSyncRunner({
    logger,
    resolveSession: async () => session,
    open: fake.open,
    watchHead: (gitDir, listener, warn) =>
      watchHeadLog(gitDir, listener, warn, (path, _options, fire) => {
        watched = path
        onChange = fire
        return Object.assign(new EventEmitter(), { close: () => { closed = true } }) as unknown as FSWatcher
      }),
  })
  await runner.acquire("agent", paths, { enabled: true })
  expect(watched).toBe(join(paths.repo, ".git", "logs", "HEAD"))
  expect(fake.commits()).toBe(1)
  onChange()
  expect(fake.commits()).toBe(2)
  await runner.release(paths.repo)
  expect(closed).toBe(true)
})

test("watchHeadLog reports a missing reflog instead of silently never firing", () => {
  const warnings: string[] = []
  const stop = watchHeadLog("/nonexistent/.git", () => undefined, (m) => warnings.push(m))
  stop()
  expect(warnings).toHaveLength(1)
})
