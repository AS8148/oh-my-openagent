import { expect, test } from "bun:test"

import type { EngineStatus } from "@oh-my-opencode/memory-core/sync-engine"

import { SYNC_RECOVERED_NOTICE, createSyncStatusNotifier } from "./sync-status-surface"

const failing = (kind: "offline" | "auth_expired", reason: string, action: string): EngineStatus => ({
  kind: "failing",
  since: 0,
  attempts: 3,
  failure: { kind, reason, action },
})

test("#given sync transitions #when the notifier hears them #then the person gets one notice per failure kind with its reason and action, and one on recovery (omo #10637)", async () => {
  let status: EngineStatus | null = { kind: "synced", at: 1, updatedWhileOffline: 0 }
  const notices: Array<{ message: string; level: string }> = []
  const ui = { notify: (message: string, level: "info" | "warning" | "error") => notices.push({ message, level }) }
  const notifier = createSyncStatusNotifier(async () => status)

  await notifier.changed("/repo", ui)
  expect(notices).toEqual([])

  status = failing("offline", "Cannot reach the service.", "Check your connection.")
  await notifier.changed("/repo", ui)
  await notifier.changed("/repo", ui)
  status = failing("auth_expired", "Sign-in expired.", "Sign in to OmO again.")
  await notifier.changed("/repo", ui)
  status = { kind: "synced", at: 2, updatedWhileOffline: 0 }
  await notifier.changed("/repo", ui)
  await notifier.changed("/repo", ui)

  expect(notices).toEqual([
    { message: "Memory sync is blocked. Cannot reach the service. Check your connection.", level: "warning" },
    { message: "Memory sync is blocked. Sign-in expired. Sign in to OmO again.", level: "warning" },
    { message: SYNC_RECOVERED_NOTICE, level: "info" },
  ])
})
