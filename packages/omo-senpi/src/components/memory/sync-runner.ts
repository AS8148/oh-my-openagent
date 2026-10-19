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

/** The one line a runner logs when this device has no session to sync with (no network, no state). */
export const SYNC_IDLE_NO_DEVICE_SESSION = "sync idle: no device session"

/** The status of a repo whose sync engine could not be loaded (the packaged sidecar is missing or broken). */
export const SYNC_UNAVAILABLE = "sync-unavailable"

export interface SyncUnavailableStatus {
  readonly kind: typeof SYNC_UNAVAILABLE
  readonly reason: string
}

type SyncRuntime = Pick<typeof import("#omo-memory-sync-runtime"), "openDeviceSync">

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
  /** Loads the engine sidecar; the default is the packaged `#omo-memory-sync-runtime` import. */
  readonly loadRuntime?: () => Promise<SyncRuntime>
  readonly watchHead?: HeadWatch
}

interface Running {
  readonly device: DeviceSync
  readonly unwatch: () => void
}

interface Held {
  users: number
  readonly ready: Promise<Running | SyncUnavailableStatus | null>
}

export interface SyncRunner {
  acquire(identity: string, paths: MemoryIdentityPaths, settings: { readonly enabled: boolean }): Promise<void>
  release(repo: string): Promise<void>
  status(repo: string): Promise<EngineStatus | SyncUnavailableStatus | null>
}

export function createSyncRunner(options: SyncRunnerOptions): SyncRunner {
  const resolveSession = options.resolveSession ?? noAccountSession
  // The engine (and the Loro wasm under it) loads only once a device has an account session.
  const loadRuntime = options.loadRuntime ?? (() => import("#omo-memory-sync-runtime"))
  const open = options.open ?? (async (o: OpenDeviceSyncOptions) => (await loadRuntime()).openDeviceSync(o))
  const watchHead = options.watchHead ?? watchHeadLog
  const { logger } = options
  const repos = new Map<string, Held>()
  // A repo whose last session released it, until its engine has closed and dropped the device lease.
  const closing = new Map<string, Promise<void>>()

  const start = async (identity: string, paths: MemoryIdentityPaths): Promise<Running | SyncUnavailableStatus | null> => {
    const session = await resolveSession(identity)
    if (session === null) {
      logger.info(SYNC_IDLE_NO_DEVICE_SESSION, { identity })
      return null
    }
    if (options.open === undefined) {
      // A missing or unloadable sidecar is an install defect, not a sync failure: report it as a
      // typed status and keep the session running without sync.
      const loaded = await loadRuntime().then(() => null, (error: unknown) => String(error))
      if (loaded !== null) {
        logger.warn("memory sync unavailable: the sync engine sidecar could not be loaded", { identity, code: SYNC_UNAVAILABLE, reason: loaded })
        return { kind: SYNC_UNAVAILABLE, reason: loaded }
      }
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
      // A session rebinding the repo right after the previous one released it would otherwise race
      // the old engine's lease and stay idle; wait for that close first.
      await closing.get(paths.repo)
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
      const done = (async () => {
        const running = await held.ready
        if (running === null || !("device" in running)) return
        running.unwatch()
        await running.device.close()
      })()
      const settled = done.catch(() => undefined)
      closing.set(repo, settled)
      try {
        await done
      } finally {
        if (closing.get(repo) === settled) closing.delete(repo)
      }
    },
    async status(repo) {
      const running = await repos.get(repo)?.ready
      if (running === undefined || running === null) return null
      return "device" in running ? running.device.status() : running
    },
  }
}
