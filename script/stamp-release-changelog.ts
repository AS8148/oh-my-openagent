#!/usr/bin/env bun
/**
 * Release-state step: assemble `changes/unreleased/*.md` into `## [Unreleased]`, stamp that
 * section into the released section for <version>, and delete the consumed fragments — all in the
 * release commit. Refuses to release an empty fragment set and refuses to silently drop
 * hand-written Unreleased content: Unreleased is machine-assembled from fragments (#9961).
 */
import { readdir, rm } from "node:fs/promises"
import { assembleUnreleasedBody, FRAGMENT_DIR, mergeUnreleased, readFragments, unreleasedBody } from "./changelog-fragments"
import { stampUnreleased } from "./changelog-release-notes"

async function main(): Promise<void> {
  const version = process.argv[2]
  const date = process.argv[3] ?? new Date().toISOString().slice(0, 10)
  if (!version) {
    console.error("usage: bun script/stamp-release-changelog.ts <version> [YYYY-MM-DD]")
    process.exit(2)
  }
  const changelogPath = new URL("../CHANGELOG.md", import.meta.url)
  const fragmentDir = new URL(`../${FRAGMENT_DIR}/`, import.meta.url)
  const names = (await readdir(fragmentDir)).filter((name) => name.endsWith(".md"))
  const contents = new Map<string, string>()
  for (const name of names) contents.set(name, await Bun.file(new URL(name, fragmentDir)).text())
  const fragments = readFragments(names, (name) => {
    const content = contents.get(name)
    if (content === undefined) throw new Error(`missing fragment file: ${name}`)
    return content
  })
  if (fragments.length === 0) throw new Error(`no changelog fragments under ${FRAGMENT_DIR}/ to release`)
  const assembled = assembleUnreleasedBody(fragments)
  const changelog = await Bun.file(changelogPath).text()
  const existing = unreleasedBody(changelog)
  if (existing && existing !== assembled) {
    throw new Error(`## [Unreleased] holds hand-written content; move it into ${FRAGMENT_DIR}/ fragments`)
  }
  const stamped = stampUnreleased(mergeUnreleased(changelog, assembled), version, date)
  await Bun.write(changelogPath, stamped)
  for (const fragment of fragments) await rm(new URL(`${fragment.pr}.md`, fragmentDir))
  console.error(`stamped ## [${version}] - ${date} from ${fragments.length} fragment(s): ${fragments.map((f) => `#${f.pr}`).join(", ")}`)
}

if (import.meta.main) await main()
