import { realpathSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"

import { readSessionContext } from "@oh-my-opencode/senpi-task"

const CHILDREN_DIR = "children"

// A hosted child session's own task id, read from the session context its spawner attached
// (`buildChildContext`: task_id plus state_dir = <task store>/children/<task_id>). Task ids are only unique within one store, so the id is
// trusted only when the whole resolved state_dir EQUALS <this engine's store>/children/<task_id>;
// anything else (no context, a foreign store, a lookalike path, a mismatched id) answers undefined (#10881).
export function ownHostedTaskId(pi: unknown, engineStateDir: string): string | undefined {
  const context = readSessionContext(pi)
  const taskId = context?.["task_id"]
  const childStateDir = context?.["state_dir"]
  if (taskId === undefined || !isSinglePathSegment(taskId)) return undefined
  if (childStateDir === undefined || childStateDir.length === 0 || engineStateDir.length === 0) return undefined
  const expected = join(canonical(engineStateDir), CHILDREN_DIR, taskId)
  return canonical(childStateDir) === expected ? taskId : undefined
}

// A task id is one folder name, never a path step: otherwise join() would normalize it onto another folder.
function isSinglePathSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && basename(value) === value
}

// The real path of `path`, resolved through its nearest existing ancestor, so the same store spelled
// through a symlink (darwin's /tmp -> /private/tmp) compares equal even before the child's folder exists.
function canonical(path: string): string {
  const absolute = resolve(path)
  const missing: string[] = []
  let current = absolute
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return absolute
      missing.push(basename(current))
      current = parent
    }
  }
}
