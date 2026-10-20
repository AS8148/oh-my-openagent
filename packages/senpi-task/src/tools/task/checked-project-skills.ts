import { existsSync, readdirSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { parseFrontmatter } from "@oh-my-opencode/utils"
import {
  checkSkillPath, readSkillFileChecked, SkillLinkBlockedError, type SkillProvenance,
} from "@oh-my-opencode/skills-loader-core/opencode-skill-loader"
import type { LoadedSkill } from "./types"

export type CheckedProjectSkills = {
  readonly skills: ReadonlyMap<string, LoadedSkill>
  readonly blocked: readonly SkillLinkBlockedError[]
}

export function readProjectSkills(dir: string, provenance: SkillProvenance): CheckedProjectSkills {
  const skills = new Map<string, LoadedSkill>()
  const blocked: SkillLinkBlockedError[] = []
  function walk(path: string, ancestry: ReadonlySet<string>): void {
    try {
      const canonical = checkSkillPath(path, provenance, true)
      if (statSync(canonical).isDirectory()) {
        if (ancestry.has(canonical)) return
        const next = new Set([...ancestry, canonical])
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          if (!entry.name.startsWith(".")) walk(join(path, entry.name), next)
        }
      } else if (path.toLowerCase().endsWith(".md")) {
        const raw = readSkillFileChecked(path, provenance)
        const { data, body } = parseFrontmatter<{ name?: string }>(raw)
        const name = data.name ?? (basename(path) === "SKILL.md" ? basename(dirname(path)) : basename(path, ".md"))
        if (!skills.has(name)) skills.set(name, { name, content: body.trim(), location: path })
      }
    } catch (error) {
      if (error instanceof SkillLinkBlockedError) blocked.push(error)
      else if (!(error instanceof Error)) throw error
    }
  }
  if (existsSync(dir)) walk(dir, new Set())
  return { skills, blocked }
}
