#!/usr/bin/env bun
import { execFileSync } from "node:child_process"
import { isUserFacingPath, shippingPolicy } from "./changelog-shipping-policy.mjs"
import { assembleUnreleasedBody, fragmentPath, FRAGMENT_DIR, readFragments } from "./changelog-fragments"

export { isUserFacingPath }

const noChangelogLabel = "no-changelog"

export function hasAddedUnreleasedLine(before, after, diff) {
  // Keep original line numbers while ignoring Markdown comments, including multiline ones.
  const visible = after.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ""))
  const eligible = new Set()
  let inUnreleased = false
  for (const [index, line] of visible.split("\n").entries()) {
    if (/^##\s/.test(line)) {
      inUnreleased = /^## \[Unreleased\](?:\s.*)?$/.test(line)
      continue
    }
    if (inUnreleased && line.trim() && !/^#{1,6}\s/.test(line.trim())) eligible.add(index + 1)
  }
  let headLine = 0
  let inHunk = false
  for (const line of diff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      headLine = Number(hunk[1])
      inHunk = true
    } else if (inHunk && line.startsWith("+")) {
      // Any added line inside Unreleased is a hand edit, including a copy of an older released
      // line: between releases the section is always empty, so no legitimate addition exists.
      if (eligible.has(headLine)) return true
      headLine += 1
    } else if (inHunk && line.startsWith(" ")) {
      headLine += 1
    }
  }
  return false
}

// Paragraphs this PR adds to ## [Unreleased]: quoted in hand-edit refusals.
export function addedUnreleasedParagraphs(before, after, diff) {
  const added = new Set(diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1).trim()).filter(Boolean))
  const section = /^## \[Unreleased\][^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(after.replace(/<!--[\s\S]*?-->/g, ""))
  if (!section) return []
  return section[1].split(/\n\s*\n/).map((block) => block.split("\n").filter((line) => !/^#{1,6}\s/.test(line.trim())).join("\n").trim()).filter((block) => {
    if (!block) return false
    if (!block.split("\n").some((line) => added.has(line.trim()))) return false
    const title = /^\*\*(.+?)\*\*/.exec(block)?.[1]
    return title ? !before.includes(`**${title}**`) : !before.includes(block)
  })
}

function hasOwnPrLink(fragmentContent, prNumber) {
  return new RegExp(`code-yeongyu/oh-my-openagent/pull/${prNumber}\\)`).test(fragmentContent)
}

const sectionsOf = (text) => text.split(/(?=^##\s)/m).map((part) => {
  const [heading, ...body] = part.split("\n")
  return { heading, body: body.join("\n").trim() }
})

// A release commit consumes the base's fragments: Unreleased stays empty and the new version
// section's body equals exactly what assembling those fragments produces.
export function fragmentReleaseTransition({ before, after, deletedFragments }) {
  if (deletedFragments.length === 0) return false
  const current = sectionsOf(after)
  const index = current.findIndex((section) => /^## \[Unreleased\](?:\s.*)?$/.test(section.heading))
  if (index < 0 || current[index].body) return false
  const released = current[index + 1]
  const version = /^## \[(\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?)\](?:[ \t].*)?$/.exec(released?.heading ?? "")
  if (!version) return false
  const previousSections = sectionsOf(before)
  if (previousSections.some((section) => section.heading.startsWith(`## [${version[1]}]`))) return false
  // Every pre-existing section must be identical: a release may not rewrite older released notes.
  const currentRest = current.filter((_, position) => position !== index && position !== index + 1)
  const previousRest = previousSections.filter((section) => !/^## \[Unreleased\](?:\s.*)?$/.test(section.heading))
  if (currentRest.length !== previousRest.length) return false
  for (let position = 0; position < currentRest.length; position += 1) {
    if (currentRest[position].heading !== previousRest[position].heading || currentRest[position].body !== previousRest[position].body) return false
  }
  return released.body === assembleUnreleasedBody(deletedFragments).trim()
}

export function checkPrChangelog({ changedFiles, policy, previousPolicy = policy, before, after, diff, labels = [], prNumber, fragment, deletedFragments = [] }) {
  const userFacingFiles = changedFiles.filter((path) => isUserFacingPath(path, policy) || isUserFacingPath(path, previousPolicy))
  const handEdited = hasAddedUnreleasedLine(before, after, diff)
  const headingMissing = !/^## \[Unreleased\](?:\s.*)?$/m.test(after)
  const consumed = fragmentReleaseTransition({ before, after, deletedFragments })
  // A PR that deletes fragments must BE a release: the CHANGELOG edit has to equal exactly
  // what assembling those fragments produces; anything else fails instead of hiding behind the
  // label or no-user-facing exits.
  if (deletedFragments.length > 0 && !consumed) {
    return { pass: false, reason: "deleted changelog fragments without the matching release edit in CHANGELOG.md", userFacingFiles }
  }
  if (consumed && userFacingFiles.length === 0) {
    return { pass: true, reason: "consumed changelog fragments into a new release section", userFacingFiles }
  }
  // A direct edit to ## [Unreleased] is the exact conflict source this gate exists to stop: it is
  // refused in every case, including a no-changelog label and a PR with no other user-facing files.
  // A renamed or missing heading is refused the same way: nothing legitimate ever removes it.
  if ((handEdited || headingMissing) && !consumed) {
    const hand = prNumber ? addedUnreleasedParagraphs(before, after, diff) : []
    const what = headingMissing ? "removed or renamed ## [Unreleased]" : `hand-edited ## [Unreleased] (${hand.map((p) => p.split("\n")[0].slice(0, 60)).join(" | ")})`
    return { pass: false, reason: `${what}; Unreleased is assembled from ${FRAGMENT_DIR}/ fragments at release time`, userFacingFiles }
  }
  if (labels.includes(noChangelogLabel)) return { pass: true, reason: "no-changelog label present", userFacingFiles }
  if (userFacingFiles.length === 0) return { pass: true, reason: "no user-facing changes", userFacingFiles }
  if (prNumber && fragment !== undefined) {
    if (!fragment.content.trim()) return { pass: false, reason: `changelog fragment ${fragmentPath(prNumber)} is empty`, userFacingFiles }
    if (!hasOwnPrLink(fragment.content, prNumber)) {
      return { pass: false, reason: `changelog fragment ${fragmentPath(prNumber)} does not link this PR (https://github.com/code-yeongyu/oh-my-openagent/pull/${prNumber})`, userFacingFiles }
    }
    return { pass: true, reason: `added ${fragmentPath(prNumber)}`, userFacingFiles }
  }
  // A release PR changes only CHANGELOG.md and fragments; user-facing code in the same PR is
  // refused outright so a release can never smuggle a code change past the fragment requirement.
  if (consumed && userFacingFiles.length > 0) {
    return { pass: false, reason: "a release PR must not change user-facing files; move the change to its own PR with a fragment", userFacingFiles }
  }
  return { pass: false, reason: "user-facing changes without a changelog fragment", userFacingFiles }
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
  const readChangelog = (revision) => {
    const exists = git("ls-tree", "--name-only", revision, "--", "CHANGELOG.md").trim()
    return exists ? git("show", `${revision}:CHANGELOG.md`) : ""
  }
  const ownPath = prNumber ? fragmentPath(prNumber) : null
  const fragment = ownPath && changedFiles.includes(ownPath)
    ? { name: `${prNumber}.md`, content: git("show", `${head}:${ownPath}`) }
    : undefined
  const deletedNames = git("diff", "--no-renames", "--name-only", "--diff-filter=D", "-z", mergeBase, head, "--", FRAGMENT_DIR).split("\0").filter(Boolean)
  let deletedFragments = []
  if (deletedNames.length > 0) {
    try {
      deletedFragments = readFragments(deletedNames.map((path) => path.slice(FRAGMENT_DIR.length + 1)), (name) => git("show", `${mergeBase}:${FRAGMENT_DIR}/${name}`))
    } catch (error) {
      console.log(`changelog-gate: FAIL - ${error.message}`)
      return 1
    }
  }
  // Validate the whole fragment directory at the head, not just this PR's own file: a stray name
  // or an empty file fails here at review time instead of on release day.
  const headDirNames = git("ls-tree", "-r", "--name-only", head, "--", FRAGMENT_DIR)
    .split("\n")
    .map((path) => path.trim())
    .filter((path) => path.length > FRAGMENT_DIR.length + 1)
    .map((path) => path.slice(FRAGMENT_DIR.length + 1))
  try {
    readFragments(headDirNames, (name) => git("show", `${head}:${FRAGMENT_DIR}/${name}`))
  } catch (error) {
    console.log(`changelog-gate: FAIL - ${error.message}`)
    return 1
  }
  const result = checkPrChangelog({
    changedFiles,
    policy: policyAt(head),
    previousPolicy: policyAt(mergeBase),
    before: readChangelog(mergeBase),
    after: readChangelog(head),
    diff: git("diff", "--no-ext-diff", "--no-textconv", "--unified=0", mergeBase, head, "--", "CHANGELOG.md"),
    labels,
    prNumber,
    fragment,
    deletedFragments,
  })
  console.log(`changelog-gate: ${result.pass ? "PASS" : "FAIL"} - ${result.reason}`)
  for (const path of result.userFacingFiles) console.log(`  user-facing: ${path}`)
  if (!result.pass) console.log(prNumber ? `Add changes/unreleased/${prNumber}.md describing this change with a link to https://github.com/code-yeongyu/oh-my-openagent/pull/${prNumber}, or ask a maintainer to apply no-changelog.` : "Add a changes/unreleased/<pr-number>.md fragment, or ask a maintainer to apply no-changelog.")
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
