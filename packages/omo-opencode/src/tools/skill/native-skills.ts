import type { SkillInfo } from "./types"
import type { LoadedSkill } from "../../features/opencode-skill-loader"
import { isDisabledSkillAlias } from "../../features/opencode-skill-loader/skill-discovery"
import { dirname, join } from "node:path"
import { existsSync } from "node:fs"
import { parseFrontmatter } from "@oh-my-opencode/utils"
import {
  readSkillFileChecked, skillProvenance, readMcpJsonFromDirChecked, parseSkillMcpConfigFromFrontmatter,
  SkillLinkBlockedError,
} from "@oh-my-opencode/skills-loader-core/opencode-skill-loader"
import { detectWorktreePath } from "@oh-my-opencode/skills-loader-core/shared/project-discovery-dirs"

export type NativeSkillEntry = {
  name: string
  description: string
  location: string
  content: string
}

export function loadedSkillToInfo(skill: LoadedSkill): SkillInfo {
  return {
    name: skill.name,
    description: skill.definition.description || "",
    location: skill.path ?? skill.resolvedPath,
    scope: skill.scope,
    license: skill.license,
    compatibility: skill.compatibility,
    metadata: skill.metadata,
    allowedTools: skill.allowedTools,
  }
}

function normalizeSkillName(name: string): string {
  return name.toLowerCase()
}

function normalizeDisabledSkills(disabledSkills: ReadonlySet<string> | undefined): ReadonlySet<string> | undefined {
  if (!disabledSkills) return undefined
  return new Set(Array.from(disabledSkills, normalizeSkillName))
}

function nativeSkillScope(_native: NativeSkillEntry): LoadedSkill["scope"] {
  return "config"
}

function nativeSkillToLoadedSkill(native: NativeSkillEntry, directory = process.cwd()): LoadedSkill {
  const provenance = skillProvenance(native.location, "config", {
    kind: native.location === "<built-in>" ? "builtin" : "host",
    selectedRoot: native.location, projectRoot: detectWorktreePath(directory) ?? directory,
  })
  const checked = provenance.kind === "project-auto"
    ? readSkillFileChecked(native.location, provenance) : undefined
  const raw = checked ?? (provenance.kind !== "builtin" && existsSync(native.location)
    ? readSkillFileChecked(native.location, provenance) : native.content)
  const sidecar = provenance.kind === "builtin" ? undefined : readMcpJsonFromDirChecked(dirname(native.location), provenance)
  return {
    name: native.name,
    path: provenance.kind === "builtin" ? undefined : native.location,
    provenance,
    mcpConfig: sidecar ?? parseSkillMcpConfigFromFrontmatter(raw),
    mcpSourcePath: sidecar ? join(dirname(native.location), "mcp.json") : native.location,
    definition: {
      name: native.name,
      description: native.description,
      template: checked === undefined ? native.content : parseFrontmatter(checked).body,
    },
    scope: nativeSkillScope(native),
  }
}

function nativeSkillToAliasCheckSkill(native: NativeSkillEntry): LoadedSkill {
  const name = normalizeSkillName(native.name)
  return {
    path: native.location,
    scope: "config",
    name,
    definition: {
      name,
      description: native.description,
      template: native.content,
    },
  }
}

export function mergeNativeSkills(
  skills: LoadedSkill[],
  nativeSkills: NativeSkillEntry[],
  disabledSkills?: ReadonlySet<string>,
  directory?: string,
  onRejected?: (name: string, error: SkillLinkBlockedError) => void,
): void {
  const knownNames = new Set(skills.map((skill) => normalizeSkillName(skill.name)))
  const disabledSkillAliases = normalizeDisabledSkills(disabledSkills)
  for (const native of nativeSkills) {
    const nativeName = normalizeSkillName(native.name)
    if (knownNames.has(nativeName)) continue
    let loadedSkill: LoadedSkill
    try { loadedSkill = nativeSkillToLoadedSkill(native, directory) } catch (error) {
      if (error instanceof SkillLinkBlockedError) {
        onRejected?.(nativeName, error)
        continue
      }
      throw error
    }
    if (disabledSkillAliases && isDisabledSkillAlias(nativeSkillToAliasCheckSkill(native), disabledSkillAliases)) continue
    skills.push(loadedSkill)
    knownNames.add(nativeName)
  }
}

export function mergeNativeSkillInfos(
  skillInfos: SkillInfo[],
  nativeSkills: NativeSkillEntry[],
  disabledSkills?: ReadonlySet<string>,
  directory?: string,
  onRejected?: (name: string, error: SkillLinkBlockedError) => void,
): void {
  const knownNames = new Set(skillInfos.map((skill) => normalizeSkillName(skill.name)))
  const disabledSkillAliases = normalizeDisabledSkills(disabledSkills)
  for (const native of nativeSkills) {
    const nativeName = normalizeSkillName(native.name)
    if (knownNames.has(nativeName)) continue
    try { nativeSkillToLoadedSkill(native, directory) } catch (error) {
      if (error instanceof SkillLinkBlockedError) {
        onRejected?.(nativeName, error)
        continue
      }
      throw error
    }
    if (disabledSkillAliases && isDisabledSkillAlias(nativeSkillToAliasCheckSkill(native), disabledSkillAliases)) continue
    skillInfos.push({
      name: native.name,
      description: native.description,
      location: native.location,
      scope: nativeSkillScope(native),
    })
    knownNames.add(nativeName)
  }
}

export function isPromiseLike<TValue>(value: TValue | Promise<TValue>): value is Promise<TValue> {
  return typeof value === "object" && value !== null && "then" in value
}
