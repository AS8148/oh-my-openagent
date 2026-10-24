/**
 * Release notes from the Unreleased section plus the fragments' CHANGELOG text (#9961, #10841).
 *
 * A fragment's text is paragraphs (`**Title.** body ([#n](...))`), `### Section` groups of `- ` bullets
 * (Keep a Changelog), or both. The release section gets the paragraphs first, newest PR first through the
 * shared assembly order, then one group per section name in first-seen order. A bullet without a link to its
 * own PR gets one, so a grouped entry still names the PR that made it.
 */
import { assembleUnreleasedBody } from "./changelog-gate-rules.ts"

const PULL_URL = "https://github.com/code-yeongyu/oh-my-openagent/pull"
const SECTION = /^### (.+?)\s*$/

export type Notes = { readonly paragraphs: string; readonly sections: ReadonlyMap<string, readonly string[]> }

/** Text before the first `### ` heading, then each heading's bullets; a bullet keeps its continuation lines. */
export function parseNotes(text: string): Notes {
  const paragraphs: string[] = []
  const sections = new Map<string, string[]>()
  let current: string[] | null = null
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const heading = SECTION.exec(line)?.[1]
    if (heading !== undefined) {
      current = sections.get(heading) ?? []
      sections.set(heading, current)
    } else if (current === null) {
      paragraphs.push(line)
    } else if (line.startsWith("- ")) {
      current.push(line)
    } else if (line.trim() !== "") {
      const last = current.pop()
      if (last === undefined) throw new Error(`text under a ### heading must be a "- " bullet: ${line}`)
      current.push(`${last}\n${line}`)
    }
  }
  return { paragraphs: paragraphs.join("\n").trim(), sections }
}

const linkBullet = (bullet: string, pr: number): string =>
  bullet.includes(`/pull/${pr})`) ? bullet : `${bullet} ([#${pr}](${PULL_URL}/${pr}))`

export type Assembly = { readonly body: string; readonly duplicates: readonly number[] }

/**
 * `legacy` is the Unreleased text written before the fragments gate. A fragment whose PR a legacy entry already
 * links is a second copy of that entry (a PR that wrote both while the two rules overlapped): it is consumed
 * and reported in `duplicates`, never released twice.
 */
export function assembleRelease(legacy: string, fragments: readonly { readonly pr: number; readonly content: string }[]): Assembly {
  const covered = new Set([...legacy.matchAll(/\/pull\/(\d+)\)/g)].map((match) => Number(match[1])))
  const duplicates = fragments.filter((fragment) => covered.has(fragment.pr)).map((fragment) => fragment.pr)
  const kept = [...fragments].filter((fragment) => !covered.has(fragment.pr)).sort((left, right) => right.pr - left.pr)
  const old = parseNotes(legacy)
  const parsed = kept.map((fragment) => ({ pr: fragment.pr, notes: parseNotes(fragment.content) }))
  const paragraphs = assembleUnreleasedBody(
    parsed.map(({ pr, notes }) => ({ pr, content: notes.paragraphs })).filter((entry) => entry.content !== ""),
  )
  const groups = new Map<string, string[]>()
  for (const [name, bullets] of old.sections) groups.set(name, [...bullets])
  for (const { pr, notes } of parsed) {
    for (const [name, bullets] of notes.sections) {
      groups.set(name, [...(groups.get(name) ?? []), ...bullets.map((bullet) => linkBullet(bullet, pr))])
    }
  }
  const sections = [...groups].filter(([, bullets]) => bullets.length > 0).map(([name, bullets]) => `### ${name}\n\n${bullets.join("\n")}`)
  const body = [old.paragraphs, paragraphs, ...sections].filter((part) => part !== "").join("\n\n")
  return { body, duplicates }
}
