// settled() is the shutdown drain's wait for every git read a memory cache started in the identity repo (#11135).
// A read still running when settled() resolves keeps a git child inside the repo past session shutdown, and on
// Windows the next remove of that directory fails with EBUSY. Each row parks one entry point at a gate, calls
// settled(), and opens the gate on the next macrotask: settled() must resolve only after the gated work.

import { afterEach, describe, expect, it } from "bun:test"
import { realpathSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GitMemoryRepo } from "../git"
import { RecallCorpusCache } from "../recall/provider"
import { MemoryBlockCache } from "./cache"
import { removeTree } from "../../../../test-support/remove-tree"

const WINDOWS_INTEGRATION_TEST_TIMEOUT = process.platform === "win32" ? 20_000 : 5_000
const TEMPLATE = "raw prompt {CORE_MEMORY}"
const OPTIONS = { agentId: "settled-agent" }

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => removeTree(dir, { maxRetries: 10, retryDelay: 200 })))
})

interface Gate {
  readonly entered: Promise<void>
  enter(): void
  readonly opened: Promise<void>
  open(): void
}

function gate(): Gate {
  let enter: () => void = () => undefined
  let open: () => void = () => undefined
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { entered, enter, opened, open }
}

class HeadGatedRepo extends GitMemoryRepo {
  constructor(dir: string, private readonly headGate: Gate) {
    super({ dir, agentId: OPTIONS.agentId })
  }

  override async head(): Promise<string | null> {
    this.headGate.enter()
    await this.headGate.opened
    return super.head()
  }
}

async function seededDir(): Promise<string> {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), "memory-cache-settled-")))
  tempDirs.push(dir)
  await new GitMemoryRepo({ dir, agentId: OPTIONS.agentId }).init({
    seedFiles: [{ relativePath: "system/persona.md", content: "---\ndescription: Persona\n---\nsettled\n" }],
  })
  return dir
}

interface Row {
  readonly name: string
  start(held: Gate): Promise<{ readonly cache: { settled(): Promise<void> }; readonly work: Promise<unknown> }>
}

const rows: readonly Row[] = [
  {
    name: "a remember() compute with no persisted store",
    async start(held) {
      const dir = await seededDir()
      const cache = new MemoryBlockCache()
      const repo = new GitMemoryRepo({ dir, agentId: OPTIONS.agentId })
      const work = cache.remember(repo, "estimate", "revision", async () => {
        held.enter()
        await held.opened
        return { value: "1", persist: true }
      })
      return { cache, work }
    },
  },
  {
    name: "a remember() still loading its persisted store, before its compute starts",
    async start(held) {
      const dir = await seededDir()
      const cache = new MemoryBlockCache({
        storeBudgetMs: 60_000,
        store: async () => {
          held.enter()
          await held.opened
          return import("./block-persist")
        },
      })
      const repo = new GitMemoryRepo({ dir, agentId: OPTIONS.agentId })
      const work = cache.remember(repo, "estimate", "revision", async () => ({ value: "1", persist: true }))
      return { cache, work }
    },
  },
  {
    name: "a compile() still reading HEAD, before its block compile starts",
    async start(held) {
      const dir = await seededDir()
      const cache = new MemoryBlockCache()
      const work = cache.compile(new HeadGatedRepo(dir, held), TEMPLATE, OPTIONS)
      return { cache, work }
    },
  },
  {
    name: "work a caller runs through track(), such as a prebuild's own HEAD read",
    async start(held) {
      const dir = await seededDir()
      const cache = new MemoryBlockCache()
      const repo = new HeadGatedRepo(dir, held)
      const work = cache.track(async () => {
        const head = await repo.head()
        return head === null ? undefined : cache.compile(repo, TEMPLATE, OPTIONS, head)
      })
      return { cache, work }
    },
  },
  {
    name: "a recall corpus load() still reading HEAD, before its git reads start",
    async start(held) {
      const dir = await seededDir()
      const cache = new RecallCorpusCache({
        head: async (repo) => {
          held.enter()
          await held.opened
          return repo.head()
        },
      })
      const work = cache.load(new GitMemoryRepo({ dir, agentId: OPTIONS.agentId }))
      return { cache, work }
    },
  },
]

describe("memory cache settled()", () => {
  for (const row of rows) {
    it(`#given ${row.name} #when settled() is awaited #then it resolves only after that work finished`, async () => {
      // given
      const held = gate()
      const { cache, work } = await row.start(held)
      await held.entered
      const order: string[] = []
      const finished = work.then(() => order.push("work-finished"))

      // when
      const settled = cache.settled().then(() => order.push("settled"))
      setImmediate(() => {
        order.push("released")
        held.open()
      })
      await Promise.all([finished, settled])

      // then
      expect(order).toEqual(["released", "work-finished", "settled"])
    }, WINDOWS_INTEGRATION_TEST_TIMEOUT)
  }
})
