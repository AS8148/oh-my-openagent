import { describe, expect, test } from "bun:test"

import type { FmValue } from "../item/frontmatter"

/** Build a T2 marker block byte-exactly the way the Mini hub's md-merge-driver emits it. */
export function t2Block(day: string, forPath: string, fmText: string): string {
  const kept = fmText.replace(/-->/g, "-- >")
  return `\n<!-- memory-sync ${day}: the other machine had different frontmatter for ${forPath}; kept here so no fact is lost:\n${kept}-->\n`
}

/** Index parsed frontmatter entries by key for value-level assertions. */
export function fmValuesByKey(entries: readonly { key: string; value: FmValue }[]): Map<string, FmValue> {
  const map = new Map<string, FmValue>()
  for (const entry of entries) map.set(entry.key, entry.value)
  return map
}

/** Run git in a fixture repository; returns stdout, throws on failure. */
export function git(dir: string, args: readonly string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args])
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`)
  return r.stdout.toString()
}
