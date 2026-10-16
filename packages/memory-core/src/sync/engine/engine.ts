// The sync engine: one cycle for both directions (sync-design §5). Triggers - startup, an
// advertised head beyond the applied cursor, a 10 s poll while the event stream is down, a local
// commit after a 2 s debounce - only request a cycle; cycles run one at a time. A cycle resumes any
// journaled work, receives outside the lock, captures and applies under it, then pushes outside it;
// a stale base receives first and retries.

import { advance, applyVerified, capture } from "./apply"
import type { EngineDeps } from "./engine-deps"
import { type EngineState, SyncJournal } from "./journal"
import { push } from "./push"
import { receive } from "./receive"

export { CrashInjected, type EngineFault, INBOUND_POINTS, OUTBOUND_POINTS } from "./engine-deps"

export const POLL_MS = 10_000
export const LOCAL_DEBOUNCE_MS = 2_000
const PUSH_ATTEMPTS = 3

export interface CycleReport {
  readonly applied: number
  readonly refused: number
  readonly pushed: boolean
  readonly snapshot: number | null
}

export class SyncEngine {
  readonly journal: SyncJournal
  cyclesRun = 0
  private loaded = false
  private running: Promise<CycleReport> | null = null
  private rerun = false
  private eventHead = 0
  private appliedMirror = 0
  private waiters: ((report: CycleReport) => void)[] = []
  private unsubscribe: (() => void) | null = null
  private cancelPoll: (() => void) | null = null
  private cancelDebounce: (() => void) | null = null

  constructor(private readonly deps: EngineDeps) {
    this.journal = new SyncJournal(deps.repo.gitDir)
  }

  state(): Promise<EngineState> {
    return this.journal.state()
  }

  start(): void {
    this.unsubscribe = this.deps.transport.subscribe({
      onAdvanced: (head) => {
        this.eventHead = Math.max(this.eventHead, head)
        if (head > this.appliedMirror) this.request()
      },
      onConnected: (connected) => (connected ? this.stopPolling() : this.poll()),
    })
    this.request()
  }

  async stop(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.stopPolling()
    this.cancelDebounce?.()
    await this.running?.catch(() => undefined)
  }

  notifyLocalCommit(): void {
    this.cancelDebounce?.()
    this.cancelDebounce = this.deps.clock.after(LOCAL_DEBOUNCE_MS, () => {
      this.cancelDebounce = null
      this.request()
    })
  }

  /** The running cycle's report, or the next cycle's when none is running. */
  nextCycle(): Promise<CycleReport> {
    if (this.running !== null) return this.running
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  runCycle(): Promise<CycleReport> {
    const previous = this.running ?? Promise.resolve(null)
    const run = previous.catch(() => null).then(() => this.cycle())
    this.running = run
    const waiters = this.waiters.splice(0)
    void run.then(
      (report) => {
        for (const w of waiters) w(report)
        if (this.running === run) this.running = null
        if (this.rerun && this.eventHead > this.appliedMirror) {
          this.rerun = false
          this.request()
        }
      },
      () => {
        if (this.running === run) this.running = null
      },
    )
    return run
  }

  private request(): void {
    if (this.running !== null) {
      this.rerun = true
      return
    }
    void this.runCycle().catch((error: unknown) => this.deps.log?.(`sync cycle failed: ${String(error)}`))
  }

  private poll(): void {
    this.stopPolling()
    this.cancelPoll = this.deps.clock.after(POLL_MS, () => {
      this.request()
      this.poll()
    })
  }

  private stopPolling(): void {
    this.cancelPoll?.()
    this.cancelPoll = null
  }

  private async cycle(): Promise<CycleReport> {
    const { deps, journal } = this
    if (!this.loaded) {
      await deps.store.load()
      this.loaded = true
    }
    const before = await journal.updateState({ eventHead: Math.max(this.eventHead, (await journal.state()).eventHead) })
    if (before.cycle !== null) {
      const resumed = before.cycle
      await deps.lock.withLock(() => advance(deps, journal, resumed))
    }
    let applied = 0
    let refused = 0
    let snapshot: number | null = null
    const inbound = async () => {
      const got = await receive(deps, journal)
      refused += got.refused
      snapshot = got.snapshot ?? snapshot
      applied += (
        await deps.lock.withLock(async () => {
          await capture(deps, journal)
          return applyVerified(deps, journal)
        })
      ).batches
    }
    await inbound()
    let pushed = false
    for (let attempt = 0; attempt < PUSH_ATTEMPTS; attempt += 1) {
      const outcome = await push(deps, journal)
      if (outcome !== "stale") {
        pushed = outcome === "pushed"
        break
      }
      await inbound()
    }
    this.appliedMirror = (await journal.state()).applied
    this.cyclesRun += 1
    return { applied, refused, pushed, snapshot }
  }
}
