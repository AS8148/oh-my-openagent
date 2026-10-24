import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { removeTree } from "../../../../test-support/remove-tree"
import { agreementItemsOf, renderAgreementsFile } from "../agreements/ledger-file"
import { ackAgreement, dropAgreement } from "../agreements/mutate"
import { DEFAULT_AGREEMENTS_POLICY } from "../agreements/types"
import { renderAgreementsTarget } from "./agreements-target"
import { describeAgreementsToolViolation } from "../agreements/guard"
import { GitMemoryRepo } from "../git"
import { applyFactsBatch } from "./extraction"
import { buildDefaultSeedFiles } from "../seeds"
import { randomUUID } from "node:crypto"

const roots: string[] = []
const correction = {
  action: "new", applies: "global", text: "Use the synthetic fixture tool",
  date: "2026-09-11",
  source: { sessionId: "fixture-session", messageId: "fixture-user-turn" },
} as const

afterEach(async () => {
  for (const root of roots.splice(0)) await removeTree(root)
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agreement-replay-"))
  roots.push(root)
  await mkdir(join(root, "system"))
  const path = join(root, "system/agreements.md")
  const first = await renderAgreementsTarget(root, [correction], DEFAULT_AGREEMENTS_POLICY)
  if (first.content === undefined) throw new Error("first correction did not create a ledger")
  await writeFile(path, first.content)
  return { root, path, first: first.content }
}

test("one source event counts once within a batch and after persisted replay", async () => {
  // given
  const { root } = await fixture()

  // when
  const replay = await renderAgreementsTarget(root, [correction, correction], DEFAULT_AGREEMENTS_POLICY)

  // then
  expect(replay.content).toBeUndefined()
})

test("different turns on one date count separately, even when sessions reuse a message id", async () => {
  // given
  const { root } = await fixture()

  // when
  const changed = await renderAgreementsTarget(root, [
    { ...correction, source: { ...correction.source, messageId: "another-user-turn" } },
    { ...correction, source: { ...correction.source, sessionId: "another-session" } },
  ], DEFAULT_AGREEMENTS_POLICY)

  // then
  expect(agreementItemsOf(changed.content)[0]).toMatchObject({
    n: 3, last: "2026-09-11", status: "needs-human",
  })
})

test("one source turn can introduce two distinct agreements without conflating their events", async () => {
  // given
  const { root } = await fixture()

  // when
  const changed = await renderAgreementsTarget(root, [
    { ...correction, text: "Keep synthetic output concise" },
  ], DEFAULT_AGREEMENTS_POLICY)

  // then
  expect(agreementItemsOf(changed.content).map((item) => item.n)).toEqual([1, 1])
})

test("acknowledging a count does not let an old source correction count again", async () => {
  // given
  const { root, path, first } = await fixture()
  const item = agreementItemsOf(first)[0]
  if (item === undefined) throw new Error("missing agreement")
  const acknowledged = ackAgreement([item], item.id)
  if (acknowledged === undefined) throw new Error("agreement was not acknowledged")
  await writeFile(path, renderAgreementsFile(first, acknowledged))

  // when
  const replay = await renderAgreementsTarget(root, [correction], DEFAULT_AGREEMENTS_POLICY)

  // then
  expect(replay.content).toBeUndefined()
})

test("dropping an agreement does not recreate it when its original event is replayed", async () => {
  // given
  const { root, path, first } = await fixture()
  const item = agreementItemsOf(first)[0]
  if (item === undefined) throw new Error("missing agreement")
  const dropped = dropAgreement([item], item.id)
  if (dropped === undefined) throw new Error("agreement was not dropped")
  await writeFile(path, renderAgreementsFile(first, dropped))

  // when
  const replay = await renderAgreementsTarget(root, [correction], DEFAULT_AGREEMENTS_POLICY)

  // then
  expect(replay.content).toBeUndefined()
})

test("a legacy uncommitted extraction without source identity is refused for re-extraction", async () => {
  // given
  const { root } = await fixture()
  const { source: _source, ...legacy } = correction

  // when / then
  await expect(renderAgreementsTarget(root, [legacy], DEFAULT_AGREEMENTS_POLICY)).rejects.toBeInstanceOf(TypeError)
})

test("memory tools cannot delete source receipts after an agreement is dropped", async () => {
  // given
  const { first } = await fixture()
  const dropped = renderAgreementsFile(first, [])
  const withoutReceipts = dropped.replace(/<!-- agreement-event: [0-9a-f]{64} -->\n/g, "")

  // when / then
  expect(describeAgreementsToolViolation(dropped, withoutReceipts)).toBeDefined()
  expect(describeAgreementsToolViolation(dropped, undefined)).toBeDefined()
})

test("independent facts batches commit one source event only once", async () => {
  // given
  const { root } = await fixture()
  const dir = join(root, "memory-repo")
  const author = { agentId: "fixture-agent", authorName: "Facts Extractor" }
  const repo = new GitMemoryRepo({ dir, agentId: author.agentId })
  await repo.init({ seedFiles: buildDefaultSeedFiles() })
  await applyFactsBatch(repo, { batchId: randomUUID(), records: [], agreements: [correction] }, author)
  const firstHead = await repo.head()

  // when
  const replay = await applyFactsBatch(repo, { batchId: randomUUID(), records: [], agreements: [correction] }, author)

  // then
  expect(replay.outcome).toBe("no_facts")
  expect(await repo.head()).toBe(firstHead)
}, 30_000)
