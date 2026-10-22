import { afterEach, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveProvenance, type ProvenanceRuntime } from "./provenance-resolver"

const cwd = join(tmpdir(), "example-project")
const runtime: ProvenanceRuntime = {
  cwd, env: {},
  gitRemote: async () => "git@example.invalid:example-owner/remote-project.git",
  workspaces: [
    { name: "Path workspace", paths: [tmpdir()] },
    { name: "Owner workspace", git_owners: ["example-owner"] },
  ],
}
let root: string | undefined
afterEach(() => { if (root !== undefined) rmSync(root, { recursive: true, force: true }); root = undefined })

test("#given explicit workspace project and lane #when resolving #then environment wins without probing git", async () => {
  expect(await resolveProvenance({ ...runtime,
    env: { OMO_PROVENANCE_WORKSPACE: "Explicit", OMO_PROVENANCE_PROJECT: "explicit-project", OMO_PROVENANCE_LANE: "review" },
    gitRemote: async () => { throw new Error("git must not be read") },
  })).toEqual({ workspace: "Explicit", project: "explicit-project", lane: "review" })
})

test("#given matching git owner and path #when resolving #then git owner wins and project comes from the remote", async () => {
  expect(await resolveProvenance(runtime)).toEqual({ workspace: "Owner workspace", project: "remote-project" })
})

test.each([
  "git@fixture-machine.local:EXAMPLE-OWNER/remote-project.git",
  "https://user:password@192.0.2.7/EXAMPLE-OWNER/remote-project.git",
  "ssh://git@fixture-machine.local:2222/EXAMPLE-OWNER/remote-project.git",
])("#given remote %s #when resolving #then credentials and network identity never become labels", async (remote) => {
  expect(await resolveProvenance({ ...runtime, gitRemote: async () => remote }))
    .toEqual({ workspace: "Owner workspace", project: "remote-project" })
})

test("#given blank overrides #when resolving #then git and configured workspace still supply required labels", async () => {
  expect(await resolveProvenance({ ...runtime, env: { OMO_PROVENANCE_WORKSPACE: " ", OMO_PROVENANCE_PROJECT: "\t", OMO_PROVENANCE_LANE: "" } }))
    .toEqual({ workspace: "Owner workspace", project: "remote-project" })
})

test("#given a nonmatching remote owner #when resolving #then path wins while project still comes from git", async () => {
  expect(await resolveProvenance({ ...runtime, gitRemote: async () => "https://example.invalid/other/remote-project.git" }))
    .toEqual({ workspace: "Path workspace", project: "remote-project" })
})

test("#given no repository or matching workspace #when resolving #then delivery remains unclassified with the cwd basename", async () => {
  expect(await resolveProvenance({ ...runtime, workspaces: [], gitRemote: async () => undefined }))
    .toEqual({ workspace: "unclassified", project: "example-project" })
})

test("#given tilde prefixes and a sibling with the same start #when resolving #then only directory descendants match", async () => {
  const home = join(tmpdir(), "example-home")
  const options = { env: { HOME: home }, workspaces: [{ name: "Path workspace", paths: ["~/work"] }], gitRemote: async () => undefined }
  expect((await resolveProvenance({ ...options, cwd: join(home, "work", "repo") })).workspace).toBe("Path workspace")
  expect((await resolveProvenance({ ...options, cwd: join(home, "work-other") })).workspace).toBe("unclassified")
})

test("#given individual environment overrides #when resolving #then unset fields still derive from sender git and config", async () => {
  expect(await resolveProvenance({ ...runtime, env: { OMO_PROVENANCE_WORKSPACE: "Explicit" } })).toEqual({ workspace: "Explicit", project: "remote-project" })
  expect(await resolveProvenance({ ...runtime, env: { OMO_PROVENANCE_PROJECT: "explicit-project" } })).toEqual({ workspace: "Owner workspace", project: "explicit-project" })
})

test("#given local remotes #when resolving #then their repository name is used without treating a local directory as an owner", async () => {
  for (const remote of ["/example-owner/local-project.git", "file:///example-owner/local-project.git", "C:\\example-owner\\local-project.git"]) {
    expect(await resolveProvenance({ ...runtime, gitRemote: async () => remote })).toEqual({ workspace: "Path workspace", project: "local-project" })
  }
})

test("#given a configured native profile #when the runtime loads its own config #then its workspace table is used", async () => {
  root = mkdtempSync(join(tmpdir(), "omo-provenance-runtime-"))
  const project = join(root, "project")
  mkdirSync(join(root, ".omo"), { recursive: true })
  mkdirSync(project)
  writeFileSync(join(root, ".omo", "omo.json"), JSON.stringify({
    profiles: { review: { "[native]": { provenance: { workspaces: [{ name: "Configured workspace", git_owners: ["example-owner"] }] } } } },
  }))
  expect(await resolveProvenance({ cwd: project, env: { HOME: root, OMO_PROFILE: "review" }, gitRemote: runtime.gitRemote }))
    .toEqual({ workspace: "Configured workspace", project: "remote-project" })
})

test("#given a real sender repository #when reading its origin from a nested cwd #then only its owner and repository become labels", async () => {
  root = mkdtempSync(join(tmpdir(), "omo-provenance-git-"))
  const nested = join(root, "nested")
  mkdirSync(nested)
  const env = { ...process.env, HOME: root, GIT_CONFIG_GLOBAL: join(root, "no-config"), GIT_CONFIG_NOSYSTEM: "1", GIT_MASTER: "1" }
  execFileSync("git", ["init", "-q", root], { env, windowsHide: true })
  execFileSync("git", ["remote", "add", "origin", "ssh://git@example.invalid/example-owner/remote-project.git"], { cwd: root, env, windowsHide: true })
  expect(await resolveProvenance({ cwd: nested, env, workspaces: runtime.workspaces }))
    .toEqual({ workspace: "Owner workspace", project: "remote-project" })
})

test("#given a sender git URL rewrite #when resolving its origin #then the sender environment supplies the git configuration", async () => {
  const cwd = (root = mkdtempSync(join(tmpdir(), "omo-provenance-git-env-")))
  const config = join(cwd, "gitconfig")
  const env = { ...process.env, HOME: cwd, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1", GIT_MASTER: "1" }
  execFileSync("git", ["init", "-q", cwd], { env, windowsHide: true })
  execFileSync("git", ["remote", "add", "origin", "sender-alias:remote-project.git"], { cwd, env, windowsHide: true })
  writeFileSync(config, '[url "https://example.invalid/example-owner/"]\n\tinsteadOf = sender-alias:\n')
  expect(await resolveProvenance({ cwd, env, workspaces: runtime.workspaces }))
    .toEqual({ workspace: "Owner workspace", project: "remote-project" })
})

test("#given a broken sender git configuration #when resolving its origin #then unexpected git errors are surfaced instead of silently unclassifying", async () => {
  const cwd = (root = mkdtempSync(join(tmpdir(), "omo-provenance-git-error-")))
  const config = join(cwd, "gitconfig")
  const env = { ...process.env, HOME: cwd, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1", GIT_MASTER: "1" }
  execFileSync("git", ["init", "-q", cwd], { env, windowsHide: true })
  writeFileSync(config, "[invalid\n")
  await expect(resolveProvenance({ cwd, env, workspaces: runtime.workspaces })).rejects.toThrow("bad config line")
})
