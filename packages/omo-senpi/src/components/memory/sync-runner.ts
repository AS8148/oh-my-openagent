// End-to-end encrypted memory sync for bound sessions. Every session bound to one memory
// repository shares one engine (a refcount per repo); the last release closes it. The engine runs
// only when `memory.sync.enabled` is on AND the account session exists: the device is signed in
// and holds its keys (todo 14 device sign-in, todo 13 verifier/sealer). Until those land the
// production resolver answers null and the runner stays idle. Local commits from any writer -
// memory tools, reflection merges, a person's git commit - reach the engine through a watch on the
// repository's HEAD reflog.

import { watch } from "@oh-my-opencode/memory-core/fs"
import { join } from "node:path"

import type { MemoryIdentityPaths } from "@oh-my-opencode/memory-core"
import type { DeviceSync, EngineStatus, OpenDeviceSyncOptions, SyncSession } from "@oh-my-opencode/memory-core/sync-engine"

import type { ComponentLogger } from "../../extension/types"

export type SyncSessionResolver = (identity: string) => Promise<SyncSession | null>

/** No device sign-in or device keys exist on this client yet (todos 13 and 14). */
export const noAccountSession: SyncSessionResolver = async () => null

type HeadWatch = (gitDir: string, onChange: () => void, warn: (message: string) => void) => () => void

type FSWatcher = ReturnType<typeof watch>
type WatchFile = (path: string, options: { readonly persistent: boolean }, listener: () => void) => FSWatcher

export function watchHeadLog(
  gitDir: string,
  onChange: () => void,
  warn: (message: string) => void,
  watchFile: WatchFile = watch,
): () => void {
  let watcher: FSWatcher
  try {
    watcher = watchFile(join(gitDir, "logs", "HEAD"), { persistent: false }, onChange)
  } catch (error) {
    warn(`memory sync: cannot watch ${join(gitDir, "logs", "HEAD")} for local commits (${String(error)}); local edits sync on the next stream event or restart`)
    return () => undefined
  }
  watcher.on("error", (error) => warn(`memory sync: the HEAD reflog watch stopped (${String(error)})`))
  return () => watcher.close()
}

export interface SyncRunnerOptions {
  readonly logger: Pick<ComponentLogger, "info" | "warn" | "error">
  readonly resolveSession?: SyncSessionResolver
  readonly open?: (options: OpenDeviceSyncOptions) => Promise<DeviceSync | null>
  readonly watchHead?: HeadWatch
}

interface Running {
  readonly device: DeviceSync
  readonly unwatch: () => void
}

interface Held {
  users: number
  readonly ready: Promise<Running | null>
}

export interface SyncRunner {
  acquire(identity: string, paths: MemoryIdentityPaths, settings: { readonly enabled: boolean }): Promise<void>
  release(repo: string): Promise<void>
  status(repo: string): Promise<EngineStatus | null>
}

export function createSyncRunner(options: SyncRunnerOptions): SyncRunner {
  const resolveSession = options.resolveSession ?? noAccountSession
  // The engine (and the Loro wasm under it) loads only once a device has an account session.
  const open = options.open ?? (async (o: OpenDeviceSyncOptions) => (await import("#omo-memory-sync-runtime")).openDeviceSync(o))
  const watchHead = options.watchHead ?? watchHeadLog
  const { logger } = options
  const repos = new Map<string, Held>()

  const start = async (identity: string, paths: MemoryIdentityPaths): Promise<Running | null> => {
    const session = await resolveSession(identity)
    if (session === null) {
      logger.info("memory sync idle: this device is not signed in to sync", { identity })
      return null
    }
    const device = await open({
      repoDir: paths.repo,
      stateDir: join(paths.runtime, "sync-device"),
      locksDir: paths.locks,
      session,
      log: (line) => logger.info(line, { identity }),
    })
    if (device === null) {
      logger.info("memory sync idle: another OmO process on this device is syncing this memory", { identity })
      return null
    }
    device.engine.start()
    const unwatch = watchHead(join(paths.repo, ".git"), () => device.notifyLocalCommit(), (message) => logger.warn(message, { identity }))
    // A watch is armed some time after it is created (measured: an append right after creation was
    // missed 9 times in 30, every later one delivered). One debounced local-commit cycle covers a
    // commit that landed in that window.
    device.notifyLocalCommit()
    return { device, unwatch }
  }

  return {
    async acquire(identity, paths, settings) {
      if (!settings.enabled) return
      const held = repos.get(paths.repo)
      if (held !== undefined) {
        held.users += 1
        return
      }
      const ready = start(identity, paths).catch((error: unknown) => {
        logger.error("memory sync failed to start", { identity, error: String(error) })
        return null
      })
      repos.set(paths.repo, { users: 1, ready })
      await ready
    },
    async release(repo) {
      const held = repos.get(repo)
      if (held === undefined) return
      held.users -= 1
      if (held.users > 0) return
      repos.delete(repo)
      const running = await held.ready
      if (running === null) return
      running.unwatch()
      await running.device.close()
    },
    async status(repo) {
      const running = await repos.get(repo)?.ready
      return running === undefined || running === null ? null : running.device.status()
    },
  }
}
