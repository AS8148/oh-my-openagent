import { GitMemoryRepo } from "../git"
import { createNodeGitExec, type GitExec } from "../git/exec"
import {
  acquireLock,
  createLockRecord,
  memoryWriterLockPath,
  releaseLock,
} from "../locks"
import { runMemoryTool } from "../tools/memory"

// Subprocess fixture for omo #10177 crash-consistency coverage. Unlike writer-child.ts (which
// parks BETWEEN commits before the parent SIGKILLs it), the kill-mid-commit mode SIGKILLs itself
// while its own `git commit` process is mid-flight - the interleaving the issue's missing-object
// failure needs: object writes, index update, and ref update sampled at a random point. The peer
// mode then takes the lock over through the normal dead-owner protocol and lands follow-up
// commits. Neither mode reads stdin: the kill is self-timed, so the parent only awaits exit.

type Mode = "kill-mid-commit" | "peer"

const [modeValue, repoPath, locksPath, writerId, first, second] = process.argv.slice(2)
if (
  (modeValue !== "kill-mid-commit" && modeValue !== "peer") ||
  repoPath === undefined ||
  locksPath === undefined ||
  writerId === undefined ||
  first === undefined
) {
  throw new Error("missing crash commit child arguments")
}
const mode: Mode = modeValue
const lockPath = memoryWriterLockPath(locksPath)

function createInCommitKillExec(minDelayMs: number, maxDelayMs: number): GitExec {
  const real = createNodeGitExec()
  return {
    async run(argv, options) {
      // authorFlags prefix the command (`-c user.name=... commit -m ...`), so the literal
      // argument "commit" marks exactly the commit invocation; no other path command carries it.
      if (argv.includes("commit")) {
        const delayMs = minDelayMs + Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1))
        setTimeout(() => {
          process.kill(process.pid, "SIGKILL")
        }, delayMs)
      }
      return real.run(argv, options)
    },
  }
}

async function createCommit(repo: GitMemoryRepo, writer: string, index: number): Promise<void> {
  await runMemoryTool({
    repo,
    lock: (_domain, operation) => operation(),
    params: {
      command: "create",
      reason: `crash-consistency: ${writer} ${index}`,
      author: { agentId: `crash-${writer}`, authorName: `Writer ${writer}` },
      file_path: `concurrency/${writer}-${index}.md`,
      description: `crash-consistency write ${writer} ${index}`,
      file_text: `${writer}:${index}\n`,
    },
  })
}

if (mode === "kill-mid-commit") {
  const minDelayMs = Number.parseInt(first, 10)
  const maxDelayMs = Number.parseInt(second ?? "", 10)
  if (!Number.isInteger(minDelayMs) || !Number.isInteger(maxDelayMs) || minDelayMs < 0 || maxDelayMs < minDelayMs) {
    throw new Error(`invalid kill delay window: ${first}..${String(second)}`)
  }
  const repo = new GitMemoryRepo({
    dir: repoPath,
    agentId: `crash-${writerId}`,
    exec: createInCommitKillExec(minDelayMs, maxDelayMs),
  })
  const record = await createLockRecord("memory-write", { runId: `${writerId}-0` })
  await acquireLock(lockPath, record, { waitTimeoutMs: 15_000, retryDelayMs: 5 })
  process.stdout.write("kill-ready\n")
  try {
    await createCommit(repo, writerId, 0)
  } finally {
    await releaseLock(lockPath, record)
  }
  // Reaching here means the kill timer missed the commit window; the lock was released normally.
  process.stdout.write("done:missed\n")
} else {
  const count = Number.parseInt(first, 10)
  if (!Number.isInteger(count) || count < 1) throw new Error(`invalid peer count: ${first}`)
  const repo = new GitMemoryRepo({ dir: repoPath, agentId: `crash-${writerId}` })
  for (let index = 0; index < count; index += 1) {
    const record = await createLockRecord("memory-write", { runId: `${writerId}-${index}` })
    await acquireLock(lockPath, record, { waitTimeoutMs: 15_000, retryDelayMs: 5 })
    try {
      await createCommit(repo, writerId, index)
    } finally {
      await releaseLock(lockPath, record)
    }
  }
  process.stdout.write(`done:${count}\n`)
}
