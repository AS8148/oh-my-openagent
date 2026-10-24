import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

import { removeTree } from "../../../../test-support/remove-tree"
import { GitMemoryRepo } from "../git"
import { parseMemoryFile, renderMemoryFile } from "../memfs"
import { parsePeopleCard } from "../people"
import { buildDefaultSeedFiles } from "../seeds"
import { applyFactsBatch, type FactsExtractionRecord } from "./extraction"

const author = { agentId: "facts-agent", authorName: "Facts Extractor" }
const people = { enabled: true, maxEntries: 40, maxEntryChars: 200 }
const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await removeTree(root)
})

async function fixture(path: string, name: string, aliases: readonly string[]) {
  const dir = await mkdtemp(join(tmpdir(), "facts-alias-retention-"))
  roots.push(dir)
  const repo = new GitMemoryRepo({ dir, agentId: author.agentId })
  await repo.init({ seedFiles: [
    ...buildDefaultSeedFiles().filter((file) => file.relativePath !== path),
    {
      relativePath: path,
      content: renderMemoryFile({
        description: `Person - ${name}`, kind: "person", aliases,
      }, `- IDENTITY: ${name}\n`),
    },
  ] })
  return { dir, repo }
}

function fact(name: string, aliases: readonly string[]): FactsExtractionRecord {
  return {
    scope: "person", person: { name, aliases },
    text: `${name} reviews synthetic fixtures.`, date: "2026-09-11",
  }
}

test("a learned alias survives a later extraction and its observations stay on the existing person", async () => {
  // given
  const { dir, repo } = await fixture("people/alex/card.md", "Alex Example", ["Alex"])
  await applyFactsBatch(repo, {
    batchId: randomUUID(), records: [fact("Alex Example", ["Supervisor"])],
  }, author, { people })

  // when
  const result = await applyFactsBatch(repo, {
    batchId: randomUUID(), records: [fact("Supervisor", [])],
  }, author, { people })

  // then
  if (result.outcome !== "committed") throw new Error(`Unexpected result: ${result.outcome}`)
  expect(result.affectedPaths).toEqual(["people/alex/observations.md"])
  const card = parseMemoryFile(await readFile(join(dir, "people/alex/card.md"), "utf8"))
  expect(card.frontmatter.aliases).toEqual(["Alex", "Supervisor"])
  expect(card.body).toContain("- IDENTITY: Alex Example")
  const observations = await readFile(join(dir, "people/alex/observations.md"), "utf8")
  expect(observations).toContain("Supervisor reviews synthetic fixtures.")
}, 30_000)

test("a new alias routes subsequent records in the same batch to the existing person", async () => {
  // given
  const { repo } = await fixture("people/alex/card.md", "Alex Example", [])

  // when
  const result = await applyFactsBatch(repo, {
    batchId: randomUUID(),
    records: [fact("Alex Example", ["Supervisor"]), fact("Supervisor", ["Reviewer"])],
  }, author, { people })

  // then
  if (result.outcome !== "committed") throw new Error(`Unexpected result: ${result.outcome}`)
  expect(result.affectedPaths).toEqual(["people/alex/card.md", "people/alex/observations.md"])
  const card = parseMemoryFile(await readFile(join(repo.dir, "people/alex/card.md"), "utf8"))
  expect(card.frontmatter.aliases).toEqual(["Supervisor", "Reviewer"])
}, 30_000)

test("primary-human alias enrichment updates the primary card without creating another identity", async () => {
  // given
  const { dir, repo } = await fixture("system/human.md", "Alex Example", ["Alex"])
  await applyFactsBatch(repo, {
    batchId: randomUUID(), records: [fact("Alex", ["Supervisor"])],
  }, author, { people })

  // when
  const result = await applyFactsBatch(repo, {
    batchId: randomUUID(), records: [fact("Supervisor", [])],
  }, author, { people })

  // then
  if (result.outcome !== "committed") throw new Error(`Unexpected result: ${result.outcome}`)
  expect(result.affectedPaths).toEqual(["people/human/observations.md"])
  const card = parseMemoryFile(await readFile(join(dir, "system/human.md"), "utf8"))
  expect(card.frontmatter.aliases).toEqual(["Alex", "Supervisor"])
}, 30_000)

test("a newly created person card contains a supported identity entry", async () => {
  // given
  const { dir, repo } = await fixture("system/human.md", "Primary Person", [])
  await mkdir(join(dir, "people"), { recursive: true })

  // when
  await applyFactsBatch(repo, {
    batchId: randomUUID(), records: [fact("Alex Example", ["Alex"])],
  }, author, { people })

  // then
  const parsed = parseMemoryFile(await readFile(join(dir, "people/alex-example/card.md"), "utf8"))
  expect(parsePeopleCard(parsed.body, people).card.entries)
    .toEqual([{ prefix: "IDENTITY", content: "Alex Example" }])
}, 30_000)
