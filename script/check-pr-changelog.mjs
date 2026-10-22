#!/usr/bin/env bun
import { execFileSync } from "node:child_process"
import { isUserFacingPath, shippingPolicy } from "./changelog-shipping-policy.mjs"

export { isUserFacingPath }

const noChangelogLabel = "no-changelog"

const fragmentPath = /^changes\/unreleased\/\d+\.md$/
const unreleasedHeading = /^##\s+\[?Unreleased\]?(?:\s.*)?$/

const visible = (text) => text.replace(/<!--[\s\S]*?-->/g, "")
const hasContentLine = (text) => visible(text).split("\n").some((line) => line.trim() && !/^#{1,6}\s/.test(line.trim()))

// Body of the Unreleased section ("## [Unreleased]" or "## Unreleased"); "" when there is none.
function unreleasedBody(text) {
  let body = null
  for (const line of text.split("\n")) {
    if (/^##\s/.test(line)) {
      if (body !== null) break
      if (unreleasedHeading.test(line)) body = []
    } else if (body !== null) body.push(line)
  }
  return body === null ? "" : body.join("\n").trim()
}

function hasReleaseTransition(before, after) {
  const sections = (text) => text.split(/(?=^##\s)/m).map((part) => {
    const [heading, ...body] = part.split("\n")
    return { heading, body: body.join("\n").trim() }
  })
  const previous = sections(before)
  const current = sections(after)
  const unreleased = (section) => unreleasedHeading.test(section.heading)
  const old = previous.find(unreleased)
  const index = current.findIndex(unreleased)
  if (!old || index < 0 || current[index].body) return false
  const released = current[index + 1]
  const version = /^## \[?(\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?)\]?(?:[ \t].*)?$/.exec(released?.heading ?? "")
  if (!version || previous.some((section) => /^## \[?([^\]\s]+)/.exec(section.heading)?.[1] === version[1])) return false
  // A heading alone is not a release: move the complete existing notes, unchanged.
  return hasContentLine(old.body) && released.body === old.body
}

// changelogs: every changed CHANGELOG.md as { path, before, after }; fragments: files this PR added, as { path, content }.
export function checkPrChangelog({ changedFiles, policy, previousPolicy = policy, changelogs = [], fragments = [], labels = [], prNumber }) {
  const userFacingFiles = changedFiles.filter((path) => isUserFacingPath(path, policy) || isUserFacingPath(path, previousPolicy))
  // Unreleased is compiled from fragments at release, so no label or fragment excuses a direct edit.
  const editedUnreleased = changelogs
    .filter(({ before, after }) => unreleasedBody(before) !== unreleasedBody(after) && !hasReleaseTransition(before, after))
    .map(({ path }) => path)
  if (editedUnreleased.length > 0) {
    return { pass: false, reason: `edits the Unreleased section of ${editedUnreleased.join(", ")}; PRs never edit Unreleased, add changes/unreleased/${prNumber ?? "<PR number>"}.md instead`, userFacingFiles, editedUnreleased }
  }
  if (labels.includes(noChangelogLabel)) return { pass: true, reason: "no-changelog label present", userFacingFiles }
  if (userFacingFiles.length === 0) return { pass: true, reason: "no user-facing changes", userFacingFiles }
  const added = fragments.filter(({ path, content }) => fragmentPath.test(path) && hasContentLine(content)).map(({ path }) => path)
  if (added.length > 0) return { pass: true, reason: `added changelog fragment ${added.join(", ")}`, userFacingFiles }
  if (changelogs.some(({ before, after }) => hasReleaseTransition(before, after))) return { pass: true, reason: "moved Unreleased content into a new release section", userFacingFiles }
  return { pass: false, reason: "user-facing changes without an added changes/unreleased/<PR number>.md fragment", userFacingFiles }
}

export function main(argv) {
  const args = { "--repo": process.cwd(), "--head": "HEAD", "--labels": process.env.CHANGELOG_GATE_LABELS ?? "[]", "--pr": process.env.CHANGELOG_GATE_PR ?? "" }
  for (let index = 0; index < argv.length; index += 2) {
    if (!["--repo", "--base", "--head", "--labels", "--pr"].includes(argv[index]) || !argv[index + 1]) {
      throw new Error("usage: bun script/check-pr-changelog.mjs --base <revision> [--head <revision>] [--repo <path>] [--labels <JSON array>] [--pr <number>]")
    }
    args[argv[index]] = argv[index + 1]
  }
  const base = args["--base"] ?? process.env.CHANGELOG_GATE_BASE
  if (!base) throw new Error("missing --base")
  const labels = JSON.parse(args["--labels"])
  if (args["--pr"] && !/^\d+$/.test(args["--pr"])) throw new Error("--pr must be a PR number")
  const prNumber = args["--pr"] ? Number(args["--pr"]) : undefined
  if (!Array.isArray(labels) || labels.some((label) => typeof label !== "string")) throw new Error("labels must be a JSON string array")
  const git = (...gitArgs) => execFileSync("git", ["-C", args["--repo"], ...gitArgs], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
  // Resolve untrusted CLI revisions before using them in Git commands or tree selectors.
  const resolve = (revision) => git("rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`).trim()
  const head = resolve(args["--head"])
  const mergeBase = git("merge-base", resolve(base), head).trim()
  // Disable rename detection: deleting a shipped source by moving it to docs must still count.
  const changedFiles = git("diff", "--no-renames", "--name-only", "-z", mergeBase, head).split("\0").filter(Boolean)
  const policyAt = (revision) => shippingPolicy(
    git("ls-tree", "-r", "--name-only", "-z", revision).split("\0").filter(Boolean),
    (path) => git("show", `${revision}:${path}`),
  )
  const readAt = (revision, path) => {
    const exists = git("ls-tree", "--name-only", revision, "--", path).trim()
    return exists ? git("show", `${revision}:${path}`) : ""
  }
  const addedFiles = git("diff", "--no-renames", "--name-only", "--diff-filter=A", "-z", mergeBase, head).split("\0").filter(Boolean)
  const result = checkPrChangelog({
    changedFiles,
    policy: policyAt(head),
    previousPolicy: policyAt(mergeBase),
    changelogs: changedFiles
      .filter((path) => path.split("/").at(-1) === "CHANGELOG.md")
      .map((path) => ({ path, before: readAt(mergeBase, path), after: readAt(head, path) })),
    fragments: addedFiles.filter((path) => path.startsWith("changes/unreleased/")).map((path) => ({ path, content: readAt(head, path) })),
    labels,
    prNumber,
  })
  console.log(`changelog-gate: ${result.pass ? "PASS" : "FAIL"} - ${result.reason}`)
  for (const path of result.userFacingFiles) console.log(`  user-facing: ${path}`)
  const fragment = `changes/unreleased/${prNumber ?? "<PR number>"}.md`
  if (result.editedUnreleased) console.log(`Revert the Unreleased edit in ${result.editedUnreleased.join(", ")} and put this PR's entry in ${fragment} instead; the release compiles fragments into the changelog.`)
  else if (!result.pass) console.log(`Add ${fragment} with this PR's entry (a ### section heading such as Fixed or Changed, then the note), or ask a maintainer to apply no-changelog.`)
  return result.pass ? 0 : 1
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`changelog-gate: ERROR - ${error.message}`)
    process.exitCode = 1
  }
}
