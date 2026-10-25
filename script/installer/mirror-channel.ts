import { MirrorPlanError, shouldMoveChannel } from "./mirror-plan"
import type { R2Store } from "./r2-store"

type ChannelStore = Pick<R2Store, "readText" | "write">

export async function mirrorChannel(
  store: ChannelStore,
  live: ChannelStore,
  key: string,
  version: string,
  dryRun: boolean,
  force: boolean,
  log: (line: string) => void,
): Promise<string> {
  const current = (await live.readText(key))?.trim() ?? null
  const target = dryRun ? store : live
  const write = dryRun || shouldMoveChannel(current, version, force)
  if (write) {
    await target.write(key, `${version}\n`, "text/plain")
    log(`${dryRun ? "dry run: wrote scratch" : "moved"} ${key}: ${current ?? "(unset)"} -> ${version}`)
  } else log(`kept ${key} at ${current}; ${version} is older`)
  const pointer = (await target.readText(key))?.trim() ?? ""
  if (write && pointer !== version) throw new MirrorPlanError(`${key}: pointer read-back ${pointer} != ${version}`)
  return pointer
}
