import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import type { OmoProvenanceSettings } from "@oh-my-opencode/omo-config-core"
import { loadSenpiOmoConfig } from "../../config-resolution"
import type { Provenance } from "./types"

export type ProvenanceRuntime = {
  readonly cwd: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly workspaces?: OmoProvenanceSettings["workspaces"]
  /** A runtime IO seam, not an agent/tool argument. */
  readonly gitRemote?: (cwd: string) => Promise<string | undefined>
}

/** Structural, locale-independent: a repository is an explicit GIT_DIR or a `.git` entry (directory or worktree file) above the cwd. */
function insideRepository(cwd: string, env: Readonly<Record<string, string | undefined>>): boolean {
  if (env.GIT_DIR) return true
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return true
    if (dirname(dir) === dir) return false
  }
}

// The sender's own environment drives git (URL rewrites, GIT_CONFIG_*), so the origin is read the way the sender sees it.
// "No repository" and "no origin" are decided from structure and git's exit code (2: no such remote), never from its
// message text, which a translated git prints in the sender's language; any other git failure (a broken config, a
// timeout) is surfaced instead of silently classifying the sender as unclassified.
function originRemote(cwd: string, env: Readonly<Record<string, string | undefined>>): Promise<string | undefined> {
  if (!insideRepository(cwd, env)) return Promise.resolve(undefined)
  return new Promise((done, fail) => {
    execFile("git", ["remote", "get-url", "origin"], { cwd, env, encoding: "utf8", windowsHide: true, timeout: 1_000 }, (error, stdout, stderr) => {
      if (error === null) return done(stdout.trim())
      const missingGit = "code" in error && error.code === "ENOENT"
      const noOrigin = error.code === 2
      if (missingGit || noOrigin) return done(undefined)
      fail(new Error(`reading the sender's git origin failed: ${stderr.trim() || error.message}`))
    })
  })
}

/** Parse only the path of a network remote: credentials and host identities never become labels. */
function repository(remote: string | undefined): { readonly owner?: string; readonly project: string } | undefined {
  if (remote === undefined) return undefined
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(remote) ? URL.parse(remote) : null
  const scp = url !== null || /^[a-z]:[\\/]/i.test(remote) ? undefined : /^(?:[^/@:]+@)?[^/:]+:(.+)$/.exec(remote)?.[1]
  const path = url?.pathname ?? scp ?? remote
  const parts = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean)
  const project = parts?.at(-1)?.replace(/\.git$/, "")
  const owner = (url !== null && url.protocol !== "file:") || scp !== undefined ? parts.at(-2) : undefined
  return project ? { owner, project } : undefined
}

function contains(cwd: string, prefix: string, home: string): boolean {
  const expanded = prefix === "~" ? home : prefix.startsWith("~/") ? resolve(home, prefix.slice(2)) : prefix
  if (!isAbsolute(expanded)) return false
  const child = relative(resolve(expanded), resolve(cwd))
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`))
}

/** Called in the sender runtime; the receiver renders only the provenance saved in the envelope. */
export async function resolveProvenance(runtime: ProvenanceRuntime): Promise<Provenance> {
  const env = runtime.env ?? process.env
  const explicitWorkspace = env.OMO_PROVENANCE_WORKSPACE?.trim()
  const explicitProject = env.OMO_PROVENANCE_PROJECT?.trim()
  const lane = env.OMO_PROVENANCE_LANE?.trim()
  const extra = lane ? { lane } : {}
  if (explicitWorkspace && explicitProject) return { workspace: explicitWorkspace, project: explicitProject, ...extra }
  const repo = repository(await (runtime.gitRemote ?? ((cwd: string) => originRemote(cwd, env)))(runtime.cwd))
  const project = explicitProject || repo?.project || basename(resolve(runtime.cwd)) || "root"
  if (explicitWorkspace) return { workspace: explicitWorkspace, project, ...extra }
  const table = runtime.workspaces ?? loadSenpiOmoConfig({ cwd: runtime.cwd, env }).config.provenance?.workspaces ?? []
  const owner = repo?.owner?.toLowerCase()
  const byOwner = owner === undefined ? undefined : table.find((row) => row.git_owners?.some((candidate) => candidate.toLowerCase() === owner))
  const home = env.HOME ?? env.USERPROFILE ?? homedir()
  const workspace = byOwner ?? table.find((row) => row.paths?.some((prefix) => contains(runtime.cwd, prefix, home)))
  return { workspace: workspace?.name ?? "unclassified", project, ...extra }
}
