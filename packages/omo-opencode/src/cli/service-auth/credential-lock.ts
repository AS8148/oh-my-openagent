import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { withLock } from "@oh-my-opencode/team-core/team-state-store/locks"
import { serviceOrigin } from "./protocol"

const held = new AsyncLocalStorage<ReadonlySet<string>>()

/** Writers and effect boundaries share one origin lock; nested session writes retain ownership. */
export async function withCredentialLock<T>(api: string, action: () => Promise<T>, home = homedir()): Promise<T> {
  const id = createHash("sha256").update(serviceOrigin(api)).digest("hex")
  const directory = join(home, ".omo", "session-locks")
  const path = join(directory, `${id}.lock`)
  const owned = held.getStore()
  if (owned?.has(path)) return action()
  await mkdir(directory, { recursive: true, mode: 0o700 })
  return withLock(path, () => held.run(new Set([...owned ?? [], path]), action), {
    ownerTag: "cli-session", staleAfterMs: Number.POSITIVE_INFINITY,
  })
}
