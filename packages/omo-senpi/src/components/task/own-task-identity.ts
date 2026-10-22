import { realpathSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"

import { readSessionContext } from "@oh-my-opencode/senpi-task"

// A hosted child session's own task id, read from the session context its spawner attached
// (`buildChildContext`: task_id plus state_dir = <task store>/children/<task_id>). Task ids are only
// unique within one store, so the id is trusted only when that state_dir places it in THIS engine's
// store; anything else (no context, a foreign store, a mismatched id) answers undefined (#10818).
export function ownHostedTaskId(pi: unknown, engineStateDir: string): string | undefined {
  const context = readSessionContext(pi)
  const taskId = context?.["task_id"]
  const childStateDir = context?.["state_dir"]
  if (taskId === undefined || taskId.length === 0 || childStateDir === undefined || childStateDir.length === 0) return undefined
  if (engineStateDir.length === 0 || basename(childStateDir) !== taskId) return undefined
  return sameDirectory(dirname(dirname(childStateDir)), engineStateDir) ? taskId : undefined
}

function sameDirectory(left: string, right: string): boolean {
  return canonical(left) === canonical(right)
}

// The same store can be spelled through a symlink (darwin's /tmp -> /private/tmp).
function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}
