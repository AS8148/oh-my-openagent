import { join } from "node:path"
import { readFile } from "../fs/resilient"
import { parseMemoryFile, renderMemoryFile } from "../memfs"
import { serializePeopleCard, type PeopleLimits } from "../people"
import { stampReceipt } from "../tools/claim-frontmatter"
import type { FactsPersonTarget } from "./person-routing"

export function factsPersonCardPath(slug: string): string {
  return slug === "human" ? "system/human.md" : `people/${slug}/card.md`
}

export async function renderFactsPersonCard(
  repoDir: string,
  target: FactsPersonTarget,
  limits: PeopleLimits,
): Promise<string> {
  if (target.person === undefined) throw new TypeError(`Person target lacks identity: ${target.slug}`)
  if (target.isNew) {
    const body = serializePeopleCard({
      entries: [{ prefix: "IDENTITY", content: target.displayName }],
    }, limits)
    return renderMemoryFile({
      description: `Person - ${target.displayName}`,
      kind: "person",
      aliases: [...target.person.aliases],
    }, `${body}\n`)
  }
  const parsed = parseMemoryFile(await readFile(join(repoDir, factsPersonCardPath(target.slug)), "utf8"))
  if (parsed.frontmatter.read_only === "true") throw new TypeError("Cannot add aliases to a read-only person card")
  const frontmatter = {
    ...parsed.frontmatter,
    aliases: [...(parsed.frontmatter.aliases ?? []), ...target.person.aliases],
  }
  return renderMemoryFile(stampReceipt(parsed, frontmatter, parsed.body, undefined), parsed.body)
}
