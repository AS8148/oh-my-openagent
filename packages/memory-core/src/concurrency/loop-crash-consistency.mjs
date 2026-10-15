#!/usr/bin/env bun
// Loop driver for omo #10177: runs the two-process SIGKILL-takeover case (or the in-commit-kill
// variant) N times against fresh fixture repos, checking `git fsck --full --strict` after the
// takeover and after the follow-up commits, and reports the missing/corrupt-object failure rate.
//
// Usage:
//   bun packages/memory-core/src/concurrency/loop-crash-consistency.mjs \
//       --case sigkill --iterations 200 --load 8 [--keep-failures 5]
//
// --case sigkill    writer-child.ts kill-holder + recovery, exactly the CI case (default)
// --case in-commit  crash-commit-child.ts kill-mid-commit + peer: SIGKILL lands inside `git commit`
// --load N          run N copies of `yes >/dev/null` during the loop, killed at the end
// --keep-failures N keep at most N failed fixture roots for forensics (default 5)
//
// Exit code 0 when every iteration passed, 1 otherwise. Failure lines are JSON on stdout.

import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const concurrencyDir = fileURLToPath(new URL(".", import.meta.url))
const writerChildPath = join(concurrencyDir, "writer-child.ts")
const crashChildPath = join(concurrencyDir, "crash-commit-child.ts")

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const iterations = Number.parseInt(arg("iterations", "200"), 10)
const loadWorkers = Number.parseInt(arg("load", "0"), 10)
const caseName = arg("case", "sigkill")
const keepFailures = Number.parseInt(arg("keep-failures", "5"))
const STAGE_BOUND_MS = 120_000
const DEATH_PROOF_BOUND_MS = 5_000

if (!Number.isInteger(iterations) || iterations < 1) throw new Error("invalid --iterations")
if (caseName !== "sigkill" && caseName !== "in-commit") throw new Error("invalid --case")

function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`stage timed out after ${STAGE_BOUND_MS}ms: ${executable} ${args.join(" ")}\nstdout=${stdout}\nstderr=${stderr}`))
    }, options.timeoutMs ?? STAGE_BOUND_MS)
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("exit", (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, pid: child.pid })
    })
    if (options.stdinLines) {
      for (const line of options.stdinLines) child.stdin.write(`${line}\n`)
    }
    resolve.child = child
  })
}

function spawnChild(script, args) {
  const child = spawn(process.execPath, [script, ...args], { stdio: ["pipe", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  const lines = []
  const waiters = []
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  let buffered = ""
  child.stdout.on("data", (chunk) => {
    stdout += chunk
    buffered += chunk
    for (;;) {
      const newline = buffered.indexOf("\n")
      if (newline < 0) return
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      lines.push(line)
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        if (waiters[index].predicate(line)) {
          const waiter = waiters.splice(index, 1)[0]
          waiter.resolve(line)
        }
      }
    }
  })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })))
  return {
    child,
    exit,
    send: (message) => child.stdin.write(`${message}\n`),
    output: () => `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
    waitFor(expected, boundMs = STAGE_BOUND_MS) {
      const existing = lines.find((line) => line === expected)
      if (existing !== undefined) return Promise.resolve(existing)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`never saw "${expected}": stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`)), boundMs)
        waiters.push({
          predicate: (line) => line === expected,
          resolve: (line) => { clearTimeout(timer); resolve(line) },
        })
      })
    },
  }
}

async function git(repoPath, args) {
  const result = await run("git", ["-C", repoPath, ...args])
  if (result.code !== 0) {
    const error = new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr}`)
    error.fsckOutput = `${result.stdout}\n${result.stderr}`
    throw error
  }
  return result
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memory-crash-loop-"))
  const repo = join(root, "repo")
  const locks = join(root, "runtime", "locks")
  await mkdir(repo, { recursive: true })
  await git(repo, ["init", "-b", "main"])
  await git(repo, ["config", "commit.gpgsign", "false"])
  const contentionPath = join(root, "contention-attempts.log")
  await writeFile(contentionPath, "")
  return { root, repo, locks, contentionPath }
}

function pidGone(pid) {
  if (process.platform === "linux") {
    try {
      const statLine = readFileSync(`/proc/${pid}/stat`, "utf8")
      const stateIndex = statLine.lastIndexOf(")") + 2
      if (statLine.slice(stateIndex, stateIndex + 1) === "Z") return true
    } catch (error) {
      if (error && error.code === "ENOENT") return true
    }
  }
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return Boolean(error && error.code === "ESRCH")
  }
}

async function waitOwnerDead(lockPath, holderPid) {
  let raw
  try {
    raw = await readFile(lockPath, "utf8")
  } catch {
    return
  }
  let pid
  try {
    pid = JSON.parse(raw).pid
  } catch {
    return
  }
  if (pid !== holderPid) throw new Error(`unexpected lock owner: ${raw}`)
  const deadline = Date.now() + DEATH_PROOF_BOUND_MS
  while (!pidGone(pid)) {
    if (Date.now() >= deadline) throw new Error(`owner pid ${pid} still alive after ${DEATH_PROOF_BOUND_MS}ms`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function fsckCheck(repoPath, stage) {
  const result = await run("git", ["-C", repoPath, "fsck", "--full", "--strict"])
  const report = `${result.stdout}\n${result.stderr}`
  const broken = report
    .split("\n")
    .filter((line) => /^(error|fatal):/.test(line) || /missing|corrupt/i.test(line))
  return {
    stage,
    ok: result.code === 0 && broken.length === 0,
    exitCode: result.code,
    broken,
    dangling: report.split("\n").filter((line) => line.startsWith("dangling")).length,
    report: report.trim().slice(0, 800),
  }
}

async function sigkillIteration(fix) {
  const holder = spawnChild(writerChildPath, ["kill-holder", fix.repo, fix.locks, "holder", "10", fix.contentionPath])
  const survivor = spawnChild(writerChildPath, ["recovery", fix.repo, fix.locks, "survivor", "10", fix.contentionPath])
  await Promise.all([holder.waitFor("ready"), survivor.waitFor("ready")])
  holder.send("go")
  survivor.send("go")
  await holder.waitFor("kill-ready")
  holder.child.kill("SIGKILL")
  const holderExit = await holder.exit
  if (holderExit.signal !== "SIGKILL") throw new Error(`holder exit was ${JSON.stringify(holderExit)}, expected SIGKILL: ${holder.output()}`)
  await waitOwnerDead(join(fix.locks, "memory-write.lock"), holder.child.pid)
  const afterTakeover = await fsckCheck(fix.repo, "after-takeover")
  survivor.send("begin-recovery")
  const survivorExit = await survivor.exit
  if (survivorExit.code !== 0) throw new Error(`survivor failed: ${JSON.stringify(survivorExit)}: ${survivor.output()}`)
  const commits = await git(fix.repo, ["rev-list", "--count", "HEAD"])
  const merges = await git(fix.repo, ["rev-list", "--count", "--merges", "HEAD"])
  const afterCommits = await fsckCheck(fix.repo, "after-commits")
  return {
    commitCount: Number.parseInt(commits.stdout.trim(), 10),
    mergeCount: Number.parseInt(merges.stdout.trim(), 10),
    checks: [afterTakeover, afterCommits],
  }
}

async function inCommitIteration(fix) {
  const killer = spawnChild(crashChildPath, ["kill-mid-commit", fix.repo, fix.locks, "killer", "0", "30"])
  await killer.waitFor("kill-ready")
  const killerExit = await killer.exit
  if (killerExit.signal !== "SIGKILL" && killerExit.code !== 0) {
    throw new Error(`killer exit was ${JSON.stringify(killerExit)}: ${killer.output()}`)
  }
  const landedCommit = killerExit.code === 0
  if (!landedCommit) await waitOwnerDead(join(fix.locks, "memory-write.lock"), killer.child.pid)
  const afterTakeover = await fsckCheck(fix.repo, "after-takeover")
  const peer = spawnChild(crashChildPath, ["peer", fix.repo, fix.locks, "peer", "20"])
  const peerExit = await peer.exit
  if (peerExit.code !== 0) throw new Error(`peer failed: ${JSON.stringify(peerExit)}: ${peer.output()}`)
  const commits = await git(fix.repo, ["rev-list", "--count", "HEAD"])
  const merges = await git(fix.repo, ["rev-list", "--count", "--merges", "HEAD"])
  const afterCommits = await fsckCheck(fix.repo, "after-commits")
  return {
    commitCount: Number.parseInt(commits.stdout.trim(), 10),
    mergeCount: Number.parseInt(merges.stdout.trim(), 10),
    checks: [afterTakeover, afterCommits],
  }
}

function expectedRange(caseKind) {
  // The in-commit killer's orphaned git child can complete its one commit post-mortem; the sigkill
  // case kills a parked writer with no git child, so its count is exact.
  return caseKind === "in-commit" ? { min: 20, max: 21 } : { min: 20, max: 20 }
}

const loaders = []
for (let index = 0; index < loadWorkers; index += 1) {
  loaders.push(spawn("yes", [], { stdio: ["ignore", "ignore", "ignore"] }))
}

const started = Date.now()
const failures = []
const kept = []
let danglingTotal = 0
try {
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const fix = await fixture()
    let failure = null
    try {
      const result = caseName === "sigkill" ? await sigkillIteration(fix) : await inCommitIteration(fix)
      const { min, max } = expectedRange(caseName)
      const badCheck = result.checks.find((check) => !check.ok)
      danglingTotal += result.checks.reduce((sum, check) => sum + check.dangling, 0)
      if (badCheck) {
        failure = { iteration, stage: badCheck.stage, broken: badCheck.broken, fsckExit: badCheck.exitCode, report: badCheck.report }
      } else if (result.commitCount < min || result.commitCount > max || result.mergeCount !== 0) {
        failure = { iteration, stage: "commit-shape", commitCount: result.commitCount, expected: `${min}..${max}`, mergeCount: result.mergeCount }
      }
    } catch (error) {
      failure = { iteration, stage: "driver", message: String(error && error.message ? error.message : error).slice(0, 600) }
    }
    if (failure) {
      failures.push(failure)
      console.log(`FAIL ${JSON.stringify(failure)}`)
      if (kept.length < keepFailures) {
        kept.push(fix.root)
      } else {
        await rm(fix.root, { recursive: true, force: true })
      }
    } else {
      await rm(fix.root, { recursive: true, force: true })
    }
    if (iteration % 10 === 0 || iteration === iterations) {
      console.log(`progress ${iteration}/${iterations} failures=${failures.length}`)
    }
  }
} finally {
  for (const loader of loaders) loader.kill("SIGKILL")
}

const elapsedSec = ((Date.now() - started) / 1000).toFixed(1)
const rate = `${failures.length}/${iterations} (${((failures.length / iterations) * 100).toFixed(2)}%)`
console.log(`SUMMARY case=${caseName} iterations=${iterations} failures=${failures.length} rate=${rate} dangling-total=${danglingTotal} load=${loadWorkers} elapsed=${elapsedSec}s`)
if (kept.length > 0) console.log(`kept failure fixtures: ${kept.join(", ")}`)
process.exit(failures.length === 0 ? 0 : 1)
