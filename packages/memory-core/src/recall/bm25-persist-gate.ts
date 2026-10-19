// The exclusive gate over a repository's persisted recall terms, for work that replaces the repository
// (a backup restore). While a repository is excluded no term-store save of this process starts or lands
// in it, and saves already writing finish before the work runs; saves requested meanwhile are dropped,
// because their terms describe the tree being replaced and the next build saves again.

import { resolve } from "node:path"

const excluded = new Map<string, number>()
const writing = new Map<string, Set<Promise<void>>>()

export function isRecallTermSaveExcluded(dir: string): boolean {
  return excluded.has(resolve(dir))
}

export function trackRecallTermSave(dir: string, save: Promise<void>): void {
  const key = resolve(dir)
  const saves = writing.get(key) ?? new Set<Promise<void>>()
  writing.set(key, saves)
  saves.add(save)
  void save.finally(() => {
    saves.delete(save)
    if (saves.size === 0 && writing.get(key) === saves) writing.delete(key)
  })
}

/** Runs `work` with every term-store save of this process kept out of `dir`. */
export async function withRecallTermSavesExcluded<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const key = resolve(dir)
  excluded.set(key, (excluded.get(key) ?? 0) + 1)
  try {
    await Promise.all([...(writing.get(key) ?? [])])
    return await work()
  } finally {
    const depth = (excluded.get(key) ?? 1) - 1
    if (depth === 0) excluded.delete(key)
    else excluded.set(key, depth)
  }
}
