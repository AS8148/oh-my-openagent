// The locked half of a cycle (sync-design §5): capture local edits into journaled pending ops
// before anything remote lands, apply verified batches in seq order, then drive the cycle record
// merged -> rendered -> committed -> checkpointed. `advance` is the same code path for a fresh
// cycle and for one resumed after a crash, so each stage is reached exactly once.

import { randomBytes } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm } from "../../fs/resilient"
import { dirname, join, relative, sep } from "node:path"

import { TEMP_MARK, writeAtomic } from "./atomic"
import type { EngineDeps } from "./engine-deps"
import { type CycleRecord, fromBase64, type SyncJournal, toBase64, type WireItem } from "./journal"

export interface Applied {
  readonly batches: number
}

async function workingKeys(root: string): Promise<string[]> {
  const names = await readdir(root, { recursive: true, withFileTypes: true })
  return names
    .filter((d) => d.isFile())
    .map((d) => relative(root, join(d.parentPath, d.name)).split(sep).join("/"))
    .filter((k) => !k.startsWith(".git/") && k !== ".git" && !k.includes(TEMP_MARK))
}

const readWorking = (root: string, key: string): Promise<string | null> =>
  readFile(join(root, key), "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  })

const sameItem = (a: WireItem, b: WireItem): boolean => a.key === b.key && a.ops === b.ops

export async function capture(deps: EngineDeps, journal: SyncJournal): Promise<number> {
  const keys = [...new Set([...deps.store.keys(), ...(await workingKeys(deps.repo.root))])].sort()
  const captured: WireItem[] = []
  for (const key of keys) {
    const ops = await deps.store.capture(key, await readWorking(deps.repo.root, key))
    if (ops !== null) captured.push({ key, ops: toBase64(ops) })
  }
  if (captured.length === 0) return 0
  const pending = await journal.pending()
  const fresh = captured.filter((c) => !pending.items.some((p) => sameItem(p, c)))
  await journal.setPending({ ...pending, items: [...pending.items, ...fresh] })
  deps.fault?.("captured")
  for (const item of captured) await deps.store.apply(item.key, fromBase64(item.ops))
  await deps.store.persist()
  return captured.length
}

export async function applyVerified(deps: EngineDeps, journal: SyncJournal): Promise<Applied> {
  const resumed = (await journal.state()).cycle
  if (resumed !== null) {
    await advance(deps, journal, resumed)
    return { batches: 0 }
  }
  const records = (await journal.incoming()).filter((r) => r.stage === "verified")
  if (records.length === 0) return { batches: 0 }
  const keys = new Set<string>()
  for (const record of records) {
    const items = record.items.map((i) => ({ key: i.key, ops: fromBase64(i.ops) }))
    if (record.snapshot) await deps.store.applySnapshot({ items })
    else for (const item of items) await deps.store.apply(item.key, item.ops)
    for (const item of items) keys.add(item.key)
  }
  await deps.store.persist()
  const state = await journal.state()
  const last = records.at(-1)?.entry.seq ?? state.applied
  const cycle: CycleRecord = {
    id: randomBytes(8).toString("hex"),
    stage: "merged",
    first: state.applied + 1,
    last,
    batches: records.map((r) => r.entry),
    keys: [...keys].sort(),
    texts: {},
    treeId: null,
  }
  await journal.updateState({ cycle })
  deps.fault?.("merged")
  await advance(deps, journal, cycle)
  return { batches: records.filter((r) => !r.snapshot).length }
}

async function renderInto(deps: EngineDeps, journal: SyncJournal, key: string, text: string | null): Promise<void> {
  const target = join(deps.repo.root, key)
  if (text === null) {
    await rm(target, { force: true })
    return
  }
  const staged = join(journal.tmpDir, `${TEMP_MARK}${randomBytes(6).toString("hex")}`)
  await writeAtomic(staged, text)
  await mkdir(dirname(target), { recursive: true })
  await rename(staged, target)
}

export async function advance(deps: EngineDeps, journal: SyncJournal, start: CycleRecord): Promise<void> {
  let cycle = start
  const save = async (next: CycleRecord, point: "rendered" | "committed" | "checkpointed") => {
    cycle = next
    await journal.updateState(point === "checkpointed" ? { cycle, applied: cycle.last } : { cycle })
    deps.fault?.(point)
  }
  if (cycle.stage === "merged") {
    const texts: Record<string, string | null> = {}
    for (const key of cycle.keys) {
      texts[key] = deps.store.render(key)
      await renderInto(deps, journal, key, texts[key])
    }
    const treeId = await deps.repo.stageTree(cycle.keys)
    await save({ ...cycle, stage: "rendered", texts, treeId }, "rendered")
  }
  if (cycle.stage === "rendered") {
    const range = `${cycle.first}-${cycle.last}`
    const changed = (await deps.repo.stageTree(cycle.keys)) !== (await deps.repo.headTree())
    if (changed && !(await deps.repo.hasSyncCommit(range))) {
      const principals = [...new Set(cycle.batches.map((b) => b.author))].sort().join(", ")
      const count = cycle.keys.length
      await deps.repo.commit(cycle.keys, `sync: ${count} memories updated\n\nSync-Seq: ${range}\nSync-Principals: ${principals}`)
      deps.fault?.("git-commit")
    }
    await save({ ...cycle, stage: "committed" }, "committed")
  }
  if (cycle.stage === "committed") {
    for (const key of cycle.keys) await deps.store.markMaterialized(key, cycle.texts[key] ?? null)
    await deps.store.persist()
    await journal.recordApplied(cycle.batches)
    await save({ ...cycle, stage: "checkpointed" }, "checkpointed")
  }
  for (const batch of cycle.batches) await journal.dropIncoming(batch.seq)
  await journal.updateState({ cycle: null })
}
