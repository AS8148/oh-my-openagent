// What the TUI tells a person about memory sync (#10637): the footer shows ` sync blocked` while a
// failure is shown (status.ts), and one notice says why and what to do when it starts or changes
// kind, then one more when sync recovers. The engine reports transitions only, so a cycle that
// keeps failing the same way never repeats the notice.

import type { EngineStatus } from "@oh-my-opencode/memory-core/sync-engine"

import type { SyncUnavailableStatus } from "./sync-runner"

export type SyncStatusReader = (repo: string) => Promise<EngineStatus | SyncUnavailableStatus | null>

export interface SyncNoticeUi {
  notify(message: string, level: "info" | "warning" | "error"): void
}

export interface SyncStatusNotifier {
  changed(repo: string, ui: SyncNoticeUi | undefined): Promise<void>
}

export const SYNC_RECOVERED_NOTICE = "Memory sync is working again."

export function createSyncStatusNotifier(read: SyncStatusReader): SyncStatusNotifier {
  const announced = new Map<string, string>()
  return {
    async changed(repo, ui) {
      const status = await read(repo)
      const failure = status?.kind === "failing" ? status.failure : undefined
      const previous = announced.get(repo)
      if (failure === undefined) {
        announced.delete(repo)
        if (previous !== undefined) ui?.notify(SYNC_RECOVERED_NOTICE, "info")
        return
      }
      if (previous === failure.kind) return
      announced.set(repo, failure.kind)
      ui?.notify(`Memory sync is blocked. ${failure.reason} ${failure.action}`, "warning")
    },
  }
}
